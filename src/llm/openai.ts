// OpenAI-compatible backend. Covers LM Studio, vLLM, llama.cpp server,
// and remote OpenAI-compatible providers.
//
// Streaming is via SSE (data: <json>\n\n ... data: [DONE]).
// Tool calls in the stream arrive as fragmented deltas indexed by
// position; we accumulate them per-index and assign a fallback ID if the
// server omits one.

import { traceModelRequest } from '../telemetry/agentpond.js';
import type { Client, Pinger, StreamingClient } from './client.js';
import { type BackendError, classifyBackend, parseRetryAfter } from './errors.js';
import { newCallID } from './ids.js';
import { kimiLocksTemperature, kimiSupportsThinkingToggle } from './providers.js';
import { withRetry } from './retry.js';
import type { ChatRequest, ChatResponse, Message, ToolCall } from './types.js';

/** Annotate a backend error with the server's Retry-After so withRetry can
 *  honor it instead of its computed backoff. */
function withRetryAfter(err: BackendError, resp: Response): BackendError {
  const ms = parseRetryAfter(resp.headers.get('retry-after'));
  if (ms !== undefined) err.retryAfterMs = ms;
  return err;
}

interface OAIToolCallFragment {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OAIChoiceMessage {
  role: string;
  content?: string;
  // Some reasoning models/proxies (deepseek-reasoner-style) return the answer
  // here with an empty `content` on the non-streaming path. We fall back to it
  // so the turn isn't blank (M7).
  reasoning_content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

interface OAIChatResp {
  choices?: Array<{
    message: OAIChoiceMessage;
    finish_reason?: string;
  }>;
  error?: { message: string };
}

interface OAIStreamResp {
  choices?: Array<{
    delta?: {
      content?: string;
      // Reasoning models (kimi-k2.*, deepseek-reasoner, ...) stream their
      // chain-of-thought here before any `content`. We surface it so the UI
      // shows progress instead of a frozen spinner, but keep it OUT of the
      // returned message so it never re-enters the model's history.
      reasoning_content?: string;
      tool_calls?: OAIToolCallFragment[];
    };
    finish_reason?: string;
  }>;
}

/** Smallest non-negative integer key not already present in the map. Used to
 *  allocate a fresh synthetic tool-call index without colliding with explicit
 *  indexes the server did send. */
function nextMapKey(parts: Map<number, unknown>): number {
  let max = -1;
  for (const k of parts.keys()) if (k > max) max = k;
  return max + 1;
}

const LMSTUDIO_STOP_TOKENS = [
  '<|user|>',
  '<|assistant|>',
  '<|system|>',
  '<|observation|>',
  '<|tool|>',
  '<|tool_call|>',
  '<|tool_response|>',
  '<|function|>',
  '<|end|>',
  '<|im_end|>',
  '<|im_start|>',
  '<|endoftext|>',
];
/** Longest stop token, hoisted so the streaming tail scan doesn't recompute
 *  `Math.max(...stops.map(...))` on every chunk. A partial stop token at the
 *  end of a chunk is at most this many chars, so that's all we ever withhold. */
const MAX_STOP_TOKEN_LEN = Math.max(...LMSTUDIO_STOP_TOKENS.map((s) => s.length));
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

export class OpenAIClient implements Client, StreamingClient, Pinger {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelID: string;
  readonly label: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly temperature?: number;
  private readonly maxTokens?: number;

  constructor(
    baseURL: string,
    apiKey: string,
    model: string,
    label = 'openai-compat',
    extraHeaders: Record<string, string> = {},
    genOpts: { temperature?: number; maxTokens?: number } = {},
  ) {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.modelID = model;
    this.label = label;
    this.extraHeaders = extraHeaders;
    this.temperature = genOpts.temperature;
    this.maxTokens = genOpts.maxTokens;
  }

  static lmStudio(baseURL: string, model: string): OpenAIClient {
    // LM Studio ignores auth — pass empty so the Authorization header is
    // omitted entirely (the chat/ping paths already guard on apiKey).
    return new OpenAIClient(baseURL || 'http://localhost:1234/v1', '', model, 'lmstudio');
  }

  name(): string {
    return this.label;
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const resp = await fetch(`${this.baseURL}/models`, { method: 'GET', headers, signal });
    if (resp.status >= 500) {
      throw new Error(`${this.label} status ${resp.status}`);
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    // Retry rate limits / transient 5xx with backoff (E7). The non-streaming
    // call has no observable side effects before it returns, so it's safe to
    // re-run wholesale.
    return traceModelRequest(
      {
        messageCount: req.messages.length,
        model: this.modelID,
        provider: this.label,
        streaming: false,
        toolCount: req.tools?.length ?? 0,
      },
      () => withRetry(() => this.chatOnce(req, signal), { signal }),
    );
  }

  private async chatOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = this.encodeRequest(req, false);
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (err) {
        throw classifyBackend(this.label, err, 0, undefined);
      }
      const raw = await resp.text();
      if (resp.status !== 200) {
        throw withRetryAfter(classifyBackend(this.label, null, resp.status, raw), resp);
      }
      let out: OAIChatResp;
      try {
        out = JSON.parse(raw) as OAIChatResp;
      } catch {
        throw classifyBackend(
          this.label,
          null,
          resp.status,
          `invalid JSON from ${this.label}: ${raw}`,
        );
      }
      if (out.error) {
        // Some proxies (OpenRouter, ...) return HTTP 200 with the real failure
        // in the body — including transient rate limits. Route it through the
        // classifier so rate-limit phrasing becomes a retryable BackendError
        // instead of a plain, non-retryable Error.
        throw classifyBackend(this.label, null, resp.status, out.error.message);
      }
      if (!out.choices?.length) {
        throw new Error(`${this.label}: empty choices`);
      }
      const choice = out.choices[0];
      if (!choice) throw new Error(`${this.label}: empty choices`);
      // Prefer content; fall back to reasoning_content only when content is
      // empty (M7) so a reasoning-only non-streaming response isn't blank.
      const rawText = choice.message.content || choice.message.reasoning_content || '';
      const msg: Message = {
        role: 'assistant',
        content: this.trimLeakedTemplate(rawText),
      };
      if (choice.message.tool_calls?.length) {
        msg.toolCalls = choice.message.tool_calls.map<ToolCall>((tc) => ({
          id: tc.id ?? newCallID(),
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      return { message: msg, finishReason: choice.finish_reason ?? '' };
    } finally {
      dispose();
    }
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    return traceModelRequest(
      {
        messageCount: req.messages.length,
        model: this.modelID,
        provider: this.label,
        streaming: true,
        toolCount: req.tools?.length ?? 0,
      },
      () => this.chatStreamOnce(req, onDelta, signal),
    );
  }

  private async chatStreamOnce(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    // Retry only the connection setup (E7): a transient 429/5xx surfaces before
    // any delta is emitted, so re-running openStream can't double-emit tokens.
    // Once the 200 stream is flowing, a mid-stream failure is NOT retried.
    const { resp, dispose } = await withRetry(() => this.openStream(req, signal), { signal });
    if (!resp.body) {
      dispose();
      throw new Error(`${this.label}: empty stream body`);
    }

    // Accumulate visible text as chunks and join once at the end (avoids the
    // O(n²) `rawContent += delta` re-allocation). `pending` holds the trailing
    // bytes withheld because they might be the head of a split stop token; the
    // template scan only ever looks at `pending + delta`, a bounded window, so
    // it no longer re-scans the whole buffer on every chunk (LM Studio fix).
    const chunks: string[] = [];
    let pending = '';
    let finish = '';
    const parts = new Map<number, { id: string; name: string; args: string }>();
    // Synthetic index for servers that omit tool_call `index`. Persisted across
    // chunks so one call's fragments don't land in a fresh entry each chunk and
    // split its name/args (M6). -1 = no fallback call started yet.
    let fallbackIndex = -1;
    let stoppedByTemplate = false;

    try {
      for await (const line of iterSSE(resp.body)) {
        if (stoppedByTemplate) break;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        let chunk: OAIStreamResp;
        try {
          chunk = JSON.parse(data) as OAIStreamResp;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta ?? {};
        // Stream reasoning as visible progress (drives the UI off "planning")
        // but never accumulate it into chunks — the returned message must stay
        // reasoning-free so it doesn't poison the next request.
        if (delta.reasoning_content) onDelta(delta.reasoning_content);
        if (delta.content) {
          // Only re-scan the small held tail plus the new delta, never the full
          // accumulated content. A stop token can only complete within this
          // window because we always withhold any partial-stop suffix.
          const buf = pending + delta.content;
          const view = this.streamingTemplateView(buf);
          if (view.visible) {
            onDelta(view.visible);
            chunks.push(view.visible);
          }
          if (view.stopped) {
            pending = '';
            stoppedByTemplate = true;
            break;
          }
          pending = buf.slice(view.visible.length);
        }
        for (const tc of delta.tool_calls ?? []) {
          let idx: number;
          if (typeof tc.index === 'number') {
            idx = tc.index;
          } else if (tc.id || tc.function?.name || fallbackIndex < 0) {
            // A new call begins (carries an id/name) or this is the first
            // index-less fragment: allocate a fresh synthetic index.
            fallbackIndex = nextMapKey(parts);
            idx = fallbackIndex;
          } else {
            // Pure argument continuation with no index/id/name: keep appending
            // to the call we're assembling rather than starting a new one.
            idx = fallbackIndex;
          }
          const existing = parts.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          parts.set(idx, existing);
        }
      }

      // Stream ended without a stop token: the withheld tail was real text, so
      // flush it now.
      if (!stoppedByTemplate && pending) {
        onDelta(pending);
        chunks.push(pending);
      }
    } finally {
      dispose();
    }

    const finalContent = this.trimLeakedTemplate(chunks.join(''));
    const msg: Message = { role: 'assistant', content: finalContent };
    const indexes = Array.from(parts.keys()).sort((a, b) => a - b);
    if (indexes.length > 0) {
      msg.toolCalls = indexes.map<ToolCall>((i) => {
        const p = parts.get(i);
        if (!p) throw new Error('unreachable');
        return {
          id: p.id || newCallID(),
          type: 'function',
          function: { name: p.name, arguments: p.args },
        };
      });
    }
    return { message: msg, finishReason: finish };
  }

  /** Open the SSE stream and return the live 200 response paired with a
   *  `dispose` that cancels its timeout, or throw a (retry-annotated)
   *  BackendError. Extracted so withRetry can re-attempt the connection without
   *  re-entering the consume loop; on success the caller owns `dispose` and
   *  must call it once the stream is fully consumed. */
  private async openStream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<{ resp: Response; dispose: () => void }> {
    const body = this.encodeRequest(req, true);
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (err) {
        throw classifyBackend(this.label, err, 0, undefined);
      }
      if (resp.status !== 200) {
        const raw = await resp.text();
        throw withRetryAfter(classifyBackend(this.label, null, resp.status, raw), resp);
      }
      return { resp, dispose };
    } catch (err) {
      // Failed attempt: clear its timer now so a retry doesn't leak it.
      dispose();
      throw err;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { ...this.extraHeaders, 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private encodeRequest(req: ChatRequest, stream: boolean) {
    const body: {
      model: string;
      stream: boolean;
      messages: Array<{
        role: string;
        content?: string;
        tool_calls?: unknown[];
        tool_call_id?: string;
        name?: string;
      }>;
      tools?: Array<{
        type: 'function';
        function: {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        };
      }>;
      thinking?: { type: 'disabled' };
      stop?: string[];
      temperature?: number;
      max_tokens?: number;
      max_completion_tokens?: number;
    } = {
      model: this.modelID,
      stream,
      messages: req.messages.map((m) => {
        const out: {
          role: string;
          content?: string;
          tool_calls?: unknown[];
          tool_call_id?: string;
          name?: string;
        } = {
          role: m.role,
          content: m.content,
        };
        if (m.toolCallID) out.tool_call_id = m.toolCallID;
        if (m.name) out.name = m.name;
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        return out;
      }),
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      })),
    };
    if (this.label === 'kimi' && kimiSupportsThinkingToggle(this.modelID)) {
      // kimi-k2.6 / k2.5 are reasoning models: left alone they stream a
      // `reasoning_content` trace and only then the answer. `thinking:
      // disabled` suppresses that so `content` carries the answer directly
      // (verified against the live API). Moonshot v1 models don't document
      // this parameter, so keep it scoped to Kimi models that support it.
      body.thinking = { type: 'disabled' };
    }
    if (this.label === 'lmstudio') {
      body.stop = LMSTUDIO_STOP_TOKENS;
    }
    // Temperature is sent only when configured AND the model accepts it —
    // kimi-k2.6 / k2.5 lock it to 1 and 400 on anything else, so we skip it
    // for them rather than error.
    if (this.temperature !== undefined && !kimiLocksTemperature(this.modelID)) {
      body.temperature = this.temperature;
    }
    // Per-response cap bounds latency / runaway generations when configured.
    if (this.maxTokens !== undefined && this.maxTokens > 0) {
      if (this.label === 'kimi') body.max_completion_tokens = this.maxTokens;
      else body.max_tokens = this.maxTokens;
    }
    return body;
  }

  private trimLeakedTemplate(content: string): string {
    if (this.label !== 'lmstudio') return content;
    return trimAtFirstStop(content, LMSTUDIO_STOP_TOKENS);
  }

  private streamingTemplateView(raw: string): { visible: string; stopped: boolean } {
    if (this.label !== 'lmstudio') return { visible: raw, stopped: false };
    const idx = firstStopIndex(raw, LMSTUDIO_STOP_TOKENS);
    if (idx >= 0) return { visible: raw.slice(0, idx), stopped: true };
    const hold = longestStopPrefixSuffix(raw, LMSTUDIO_STOP_TOKENS);
    return { visible: hold > 0 ? raw.slice(0, -hold) : raw, stopped: false };
  }
}

function trimAtFirstStop(content: string, stops: readonly string[]): string {
  const idx = firstStopIndex(content, stops);
  return idx >= 0 ? content.slice(0, idx).trimEnd() : content;
}

function firstStopIndex(content: string, stops: readonly string[]): number {
  let best = -1;
  for (const stop of stops) {
    const idx = content.indexOf(stop);
    if (idx >= 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function longestStopPrefixSuffix(content: string, stops: readonly string[]): number {
  const max = Math.min(content.length, MAX_STOP_TOKEN_LEN - 1);
  for (let n = max; n > 0; n--) {
    const suffix = content.slice(-n);
    if (stops.some((stop) => stop.startsWith(suffix))) return n;
  }
  return 0;
}

/**
 * Decode a byte stream into SSE-style logical lines. Splits on `\n\n`
 * (event boundary) and also on `\n` for single-line events. Yields each
 * raw line so the caller can inspect `data:` / `event:` prefixes.
 */
async function* iterSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
        idx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Build a per-request abort signal that fires when `parent` aborts OR after
 *  `ms`, paired with a `dispose` that clears the timer and detaches the
 *  listener. Replaces AbortSignal.timeout/any, whose 10-minute timers stay
 *  pending (and keep the event loop alive) until they fire even after the
 *  request has settled — leaking one timer per call. Call `dispose()` in a
 *  finally once the request (incl. stream consumption) is done. */
function withTimeout(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), ms);
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
