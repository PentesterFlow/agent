import { DEFAULT_LMSTUDIO_BASE_URL } from '../config/config.js';

// OpenAI-compatible backend. Covers LM Studio, vLLM, llama.cpp server,
// and remote OpenAI-compatible providers.
//
// Streaming is via SSE (data: <json>\n\n ... data: [DONE]).
// Tool calls in the stream arrive as fragmented deltas indexed by
// position; we accumulate them per-index and assign a fallback ID if the
// server omits one.

import type { Client, Pinger, StreamingClient } from './client.js';
import { classifyBackend } from './errors.js';
import { newCallID } from './ids.js';
import { kimiLocksTemperature, kimiSupportsThinkingToggle } from './providers.js';
import type { ChatRequest, ChatResponse, Message, ToolCall } from './types.js';

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
    return new OpenAIClient(baseURL || DEFAULT_LMSTUDIO_BASE_URL, '', model, 'lmstudio');
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
    const body = this.encodeRequest(req, false);
    const combinedSignal = withTimeout(signal, CHAT_TIMEOUT_MS);
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
      throw classifyBackend(this.label, null, resp.status, raw);
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
      throw new Error(`${this.label} api error: ${out.error.message}`);
    }
    if (!out.choices?.length) {
      throw new Error(`${this.label}: empty choices`);
    }
    const choice = out.choices[0];
    if (!choice) throw new Error(`${this.label}: empty choices`);
    const msg: Message = {
      role: 'assistant',
      content: this.trimLeakedTemplate(choice.message.content ?? ''),
    };
    if (choice.message.tool_calls?.length) {
      msg.toolCalls = choice.message.tool_calls.map<ToolCall>((tc) => ({
        id: tc.id ?? newCallID(),
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    return { message: msg, finishReason: choice.finish_reason ?? '' };
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const body = this.encodeRequest(req, true);
    const combinedSignal = withTimeout(signal, CHAT_TIMEOUT_MS);
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
      throw classifyBackend(this.label, null, resp.status, raw);
    }
    if (!resp.body) {
      throw new Error(`${this.label}: empty stream body`);
    }

    let rawContent = '';
    let emittedLen = 0;
    let finish = '';
    const parts = new Map<number, { id: string; name: string; args: string }>();
    let stoppedByTemplate = false;

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
      // but never accumulate it into rawContent — the returned message must
      // stay reasoning-free so it doesn't poison the next request.
      if (delta.reasoning_content) onDelta(delta.reasoning_content);
      if (delta.content) {
        rawContent += delta.content;
        const view = this.streamingTemplateView(rawContent);
        const emitText = view.visible.slice(emittedLen);
        if (emitText) {
          onDelta(emitText);
          emittedLen += emitText.length;
        }
        if (view.stopped) {
          rawContent = view.visible;
          stoppedByTemplate = true;
          break;
        }
      }
      let fallbackIndex = parts.size;
      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : fallbackIndex++;
        const existing = parts.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        parts.set(idx, existing);
      }
    }

    const finalContent = this.trimLeakedTemplate(rawContent);
    if (!stoppedByTemplate && finalContent.length > emittedLen) {
      onDelta(finalContent.slice(emittedLen));
    }
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
  const max = Math.min(content.length, Math.max(...stops.map((s) => s.length - 1)));
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

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}
