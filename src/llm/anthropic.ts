// Anthropic Claude client (Messages API, POST /v1/messages).
//
// Hand-rolled HTTP like the other backends so it shares the project's retry
// (withRetry), error-classification (classifyBackend), and timeout machinery
// rather than pulling in the SDK and bypassing all of it. Modeled on
// gemini.ts: a dedicated Client + Pinger that does its own request/response
// encoding for a non-OpenAI wire shape.
//
// Differences from the OpenAI-compatible shape this codebase otherwise leans
// on: the system prompt is a top-level field (not a message), tool calls and
// results are content blocks (tool_use / tool_result) rather than a separate
// tool_calls array, max_tokens is mandatory, and auth is the x-api-key header
// plus a required anthropic-version header.

import type { Client, Pinger } from './client.js';
import { type BackendError, classifyBackend, parseRetryAfter } from './errors.js';
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_VERSION,
  anthropicAcceptsTemperature,
} from './providers.js';
import { withRetry } from './retry.js';
import type { ChatRequest, ChatResponse, FinishReason, Message, ToolSpec } from './types.js';

/** Annotate a backend error with the server's Retry-After so withRetry can
 *  honor it instead of its computed backoff. */
function withRetryAfter(err: BackendError, resp: Response): BackendError {
  const ms = parseRetryAfter(resp.headers.get('retry-after'));
  if (ms !== undefined) err.retryAfterMs = ms;
  return err;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
  error?: { message?: string };
}

const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

export class AnthropicClient implements Client, Pinger {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelID: string;
  private readonly temperature?: number;
  private readonly maxTokens?: number;

  constructor(
    baseURL: string,
    apiKey: string,
    model: string,
    genOpts: { temperature?: number; maxTokens?: number } = {},
  ) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.modelID = model;
    this.temperature = genOpts.temperature;
    this.maxTokens = genOpts.maxTokens;
  }

  name(): string {
    return 'anthropic';
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const resp = await fetch(`${this.baseURL}/models`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal,
    });
    if (resp.status >= 500) {
      throw new Error(`anthropic status ${resp.status}`);
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    // Retry rate limits / transient 5xx with backoff. The call has no
    // observable side effects before it returns, so re-running it is safe.
    return withRetry(() => this.chatOnce(req, signal), { signal });
  }

  private async chatOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const model = req.model || this.modelID;
    const body = encodeRequest(req, model, {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(`${this.baseURL}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (err) {
        throw classifyBackend('anthropic', err, 0, undefined);
      }
      const raw = await resp.text();
      if (resp.status !== 200) {
        throw withRetryAfter(classifyBackend('anthropic', null, resp.status, raw), resp);
      }
      let out: AnthropicResponse;
      try {
        out = JSON.parse(raw) as AnthropicResponse;
      } catch {
        throw classifyBackend(
          'anthropic',
          null,
          resp.status,
          `invalid JSON from anthropic: ${raw}`,
        );
      }
      if (out.error?.message) {
        throw classifyBackend('anthropic', null, resp.status, out.error.message);
      }
      const blocks = out.content ?? [];
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      const calls = blocks.filter((b) => b.type === 'tool_use');
      const msg: Message = { role: 'assistant', content: text };
      if (calls.length > 0) {
        msg.toolCalls = calls.map((b) => ({
          // Preserve Anthropic's own tool_use id (toolu_...): the next turn's
          // tool_result must reference it, so synthesizing one would break the
          // pairing. Unlike Gemini, the API always supplies it.
          id: b.id ?? '',
          type: 'function',
          function: {
            name: b.name ?? '',
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
      }
      return { message: msg, finishReason: mapFinishReason(out.stop_reason) };
    } finally {
      dispose();
    }
  }
}

/** Map Anthropic's stop_reason onto the project's FinishReason. Unknown values
 *  (e.g. "refusal") pass through verbatim — the union is open and callers can
 *  inspect them. */
function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return reason ?? '';
  }
}

/** Build a per-request abort signal that fires when `parent` aborts OR after
 *  `ms`, paired with a `dispose` that clears the timer and detaches the
 *  listener. Mirrors gemini.ts — avoids AbortSignal.timeout/any leaking a
 *  pending 10-minute timer per call. */
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

function encodeRequest(
  req: ChatRequest,
  model: string,
  genOpts: { temperature?: number; maxTokens?: number } = {},
): Record<string, unknown> {
  // Anthropic carries the system prompt in a dedicated top-level field, not in
  // the messages array.
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const messages = req.messages
    .filter((m) => m.role !== 'system')
    .map(encodeMessage)
    // A turn can encode to nothing (e.g. an empty assistant message); drop it
    // so we don't send a content-less block the API would reject.
    .filter((m): m is { role: 'user' | 'assistant'; content: ContentBlock[] } => m !== null);

  const body: Record<string, unknown> = {
    model,
    // max_tokens is mandatory on the Messages API; fall back to the default.
    max_tokens:
      genOpts.maxTokens && genOpts.maxTokens > 0 ? genOpts.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemText) body.system = systemText;
  if (req.tools?.length) body.tools = req.tools.map(encodeTool);
  // Only send temperature to models that accept it — opus-4-7/4-8 (and the
  // Fable/Mythos 5 family) 400 on any sampling parameter.
  if (genOpts.temperature !== undefined && anthropicAcceptsTemperature(model)) {
    body.temperature = genOpts.temperature;
  }
  return body;
}

function encodeMessage(m: Message): { role: 'user' | 'assistant'; content: ContentBlock[] } | null {
  if (m.role === 'tool') {
    // Tool results are delivered as a user turn containing tool_result blocks,
    // keyed by the tool_use id the assistant produced.
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallID ?? '',
          content: m.content,
        },
      ],
    };
  }
  if (m.role === 'assistant') {
    const content: ContentBlock[] = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    return content.length > 0 ? { role: 'assistant', content } : null;
  }
  return { role: 'user', content: [{ type: 'text', text: m.content }] };
}

function encodeTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  };
}
