import type { Client, Pinger } from './client.js';
import { classifyBackend } from './errors.js';
import { newCallID } from './ids.js';
import type { ChatRequest, ChatResponse, Message, ToolSpec } from './types.js';

interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

export class GeminiClient implements Client, Pinger {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelID: string;

  constructor(baseURL: string, apiKey: string, model: string) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.modelID = model;
  }

  name(): string {
    return 'gemini';
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const resp = await fetch(`${this.baseURL}/models?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'GET',
      signal,
    });
    if (resp.status >= 500) {
      throw new Error(`gemini status ${resp.status}`);
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = encodeRequest(req);
    let resp: Response;
    try {
      resp = await fetch(
        `${this.baseURL}/${req.model || this.modelID}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        },
      );
    } catch (err) {
      throw classifyBackend('gemini', err, 0, undefined);
    }
    const raw = await resp.text();
    if (resp.status !== 200) {
      throw classifyBackend('gemini', null, resp.status, raw);
    }
    const out = JSON.parse(raw) as GeminiResponse;
    if (out.error?.message) {
      throw new Error(`gemini api error: ${out.error.message}`);
    }
    const choice = out.candidates?.[0];
    if (!choice) throw new Error('gemini: empty candidates');
    const parts = choice.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? '')
      .filter(Boolean)
      .join('');
    const calls = parts.filter((p) => Boolean(p.functionCall?.name));
    const msg: Message = { role: 'assistant', content: text };
    if (calls.length > 0) {
      msg.toolCalls = calls.map((part) => {
        const fc = part.functionCall;
        const thoughtSignature = part.thoughtSignature ?? part.thought_signature;
        return {
          id: newCallID(),
          type: 'function',
          function: {
            name: fc?.name ?? '',
            arguments: JSON.stringify(fc?.args ?? {}),
          },
          ...(thoughtSignature
            ? { provider: { gemini: { thoughtSignature } } }
            : {}),
        };
      });
    }
    return { message: msg, finishReason: choice.finishReason ?? '' };
  }
}

function encodeRequest(req: ChatRequest): Record<string, unknown> {
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = req.messages.filter((m) => m.role !== 'system').flatMap((m) => encodeMessage(m));
  const body: Record<string, unknown> = {
    contents,
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map(encodeTool) }];
  }
  return body;
}

function encodeMessage(m: Message): GeminiContent[] {
  if (m.role === 'tool') {
    return [
      {
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: m.name || 'tool_result',
              response: { result: m.content },
            },
          },
        ],
      },
    ];
  }
  if (m.role === 'assistant') {
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      parts.push({
        functionCall: { name: tc.function.name, args },
        ...(tc.provider?.gemini?.thoughtSignature
          ? { thoughtSignature: tc.provider.gemini.thoughtSignature }
          : {}),
      });
    }
    return parts.length > 0 ? [{ role: 'model', parts }] : [];
  }
  return [{ role: 'user', parts: [{ text: m.content }] }];
}

function encodeTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: normalizeSchema(tool.function.parameters),
  };
}

function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, prop]) => [
          name,
          normalizeSchema(prop),
        ]),
      );
      continue;
    }
    if (key === 'items') {
      out.items = normalizeSchema(value);
      continue;
    }
    if (['additionalProperties', '$schema', 'definitions', '$defs'].includes(key)) continue;
    out[key] = normalizeSchema(value);
  }
  return out;
}
