import { DEFAULT_OLLAMA_BASE_URL } from '../config/config.js';

// Ollama backend. behavior:
// - POST /api/chat with stream=true emits ND-JSON; accumulate tool calls
//   as they arrive (the terminal `done:true` chunk often carries an empty
//   tool_calls slice, so relying on the last chunk drops calls).
// - Malformed streamed chunks are logged with a preview (warn level) and
//   skipped — silently dropping them caused tool calls to vanish.
// - GET /api/tags for the health probe.

import { warn } from '../logger/logger.js';
import type { Client, Pinger, StreamingClient } from './client.js';
import { classifyBackend } from './errors.js';
import { newCallID } from './ids.js';
import type { ChatRequest, ChatResponse, Message, ToolCall } from './types.js';

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResp {
  message?: OllamaMessage;
  done?: boolean;
}
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

export class OllamaClient implements Client, StreamingClient, Pinger {
  readonly baseURL: string;
  readonly modelID: string;

  constructor(baseURL: string, model: string) {
    this.baseURL = baseURL || DEFAULT_OLLAMA_BASE_URL;
    this.modelID = model;
  }

  name(): string {
    return 'ollama';
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    try {
      const resp = await fetch(`${this.baseURL}/api/tags`, { method: 'GET', signal });
      if (resp.status >= 500) {
        throw new Error(`ollama status ${resp.status}`);
      }
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error(String(err));
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = this.encodeRequest(req, false);
    const combinedSignal = withTimeout(signal, CHAT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (err) {
      throw classifyBackend('ollama', err, 0, undefined);
    }
    const raw = await resp.text();
    if (resp.status !== 200) {
      throw classifyBackend('ollama', null, resp.status, raw);
    }
    let parsed: OllamaChatResp;
    try {
      parsed = JSON.parse(raw) as OllamaChatResp;
    } catch {
      throw classifyBackend('ollama', null, resp.status, `invalid JSON from ollama: ${raw}`);
    }
    return this.assembleResponse(parsed.message ?? { role: 'assistant', content: '' }, req.tools);
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
      resp = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (err) {
      throw classifyBackend('ollama', err, 0, undefined);
    }
    if (resp.status !== 200) {
      const raw = await resp.text();
      throw classifyBackend('ollama', null, resp.status, raw);
    }
    if (!resp.body) {
      throw new Error('ollama: empty stream body');
    }

    let content = '';
    const toolCalls: OllamaToolCall[] = [];
    let skipped = 0;

    for await (const line of iterLines(resp.body)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let chunk: OllamaChatResp;
      try {
        chunk = JSON.parse(trimmed) as OllamaChatResp;
      } catch (err) {
        // Defensive logging. Drop the chunk but
        // surface enough detail to diagnose vanished tool calls.
        skipped += 1;
        const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
        warn('ollama: dropped malformed stream chunk', {
          err: err instanceof Error ? err.message : String(err),
          preview,
          total_skipped: skipped,
        });
        continue;
      }
      if (chunk.message?.content) {
        content += chunk.message.content;
        onDelta(chunk.message.content);
      }
      if (chunk.message?.tool_calls?.length) {
        toolCalls.push(...chunk.message.tool_calls);
      }
      if (chunk.done) break;
    }

    return this.assembleResponse({ role: 'assistant', content, tool_calls: toolCalls }, req.tools);
  }

  private encodeRequest(req: ChatRequest, stream: boolean) {
    return {
      model: this.modelID,
      stream,
      messages: req.messages.map((m) => {
        const out: OllamaMessage = { role: m.role, content: m.content };
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc) => {
            let args: Record<string, unknown> = {};
            if (tc.function.arguments) {
              try {
                args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                args = {};
              }
            }
            return { function: { name: tc.function.name, arguments: args } };
          });
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
  }

  private assembleResponse(msg: OllamaMessage, tools?: ChatRequest['tools']): ChatResponse {
    const out: Message = { role: 'assistant', content: msg.content ?? '' };
    const toolCalls = msg.tool_calls?.length
      ? msg.tool_calls
      : parseContentToolCalls(
          msg.content ?? '',
          new Set((tools ?? []).map((t) => t.function.name)),
        );

    if (toolCalls.length) {
      out.toolCalls = toolCalls.map<ToolCall>((tc) => ({
        id: newCallID(),
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments ?? {}),
        },
      }));
    }
    return {
      message: out,
      finishReason: out.toolCalls?.length ? 'tool_calls' : 'stop',
    };
  }
}

function parseContentToolCalls(content: string, knownTools: Set<string>): OllamaToolCall[] {
  if (knownTools.size === 0) return [];

  const parsed = parseJSONFromContent(content);
  if (parsed === undefined) return [];

  return normalizeToolCalls(parsed, knownTools);
}

function parseJSONFromContent(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function normalizeToolCalls(value: unknown, knownTools: Set<string>): OllamaToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeToolCalls(item, knownTools));
  }
  if (!isRecord(value)) return [];

  const calls =
    value.tool_calls ??
    value.toolCalls ??
    value.tool_call ??
    value.toolCall ??
    value.function_call ??
    value.functionCall;
  if (isRecord(calls)) {
    return normalizeToolCalls(calls, knownTools);
  }
  if (Array.isArray(calls)) {
    return calls.flatMap((item) => normalizeToolCalls(item, knownTools));
  }

  const functionValue = value.function;
  if (isRecord(functionValue)) {
    const call = normalizeNamedCall(functionValue.name, functionValue.arguments, knownTools);
    return call ? [call] : [];
  }
  if (typeof functionValue === 'string') {
    const args = value.arguments ?? value.args ?? value.parameters ?? value.input ?? {};
    const call = normalizeNamedCall(functionValue, args, knownTools);
    return call ? [call] : [];
  }

  const name =
    value.name ??
    value.tool ??
    value.tool_name ??
    value.toolName ??
    value.action ??
    value.action_name ??
    value.actionName;
  const args =
    value.arguments ??
    value.args ??
    value.parameters ??
    value.input ??
    value.action_input ??
    value.actionInput ??
    {};
  const call = normalizeNamedCall(name, args, knownTools);
  return call ? [call] : [];
}

function normalizeNamedCall(
  nameValue: unknown,
  argsValue: unknown,
  knownTools: Set<string>,
): OllamaToolCall | undefined {
  if (typeof nameValue !== 'string' || !knownTools.has(nameValue)) return undefined;

  let args: unknown = argsValue;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  const argsRecord = isRecord(args) ? args : {};

  return {
    function: {
      name: nameValue,
      arguments: argsRecord,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Decode a byte stream into newline-delimited string chunks. */
async function* iterLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}
