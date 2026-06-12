import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeminiClient } from './gemini.js';
import type { ChatRequest } from './types.js';

let server: Server;
let baseURL = '';
let lastBody: Record<string, unknown> | null = null;
let lastApiKeyHeader: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    // The key must ride in the x-goog-api-key header, never the URL query.
    lastApiKeyHeader = req.headers['x-goog-api-key'] as string | undefined;
    if (req.method === 'GET' && req.url === '/v1beta/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    const isStream =
      req.method === 'POST' &&
      req.url === '/v1beta/models/gemini-test:streamGenerateContent?alt=sse';
    const isGenerate =
      req.method === 'POST' && req.url === '/v1beta/models/gemini-test:generateContent';
    if (!isStream && !isGenerate) {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (isStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const event = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
        // A thought summary, then answer text split across two chunks, then a
        // function call with a finishReason.
        res.write(
          event({ candidates: [{ content: { parts: [{ text: 'pondering', thought: true }] } }] }),
        );
        res.write(event({ candidates: [{ content: { parts: [{ text: 'wor' }] } }] }));
        res.write(event({ candidates: [{ content: { parts: [{ text: 'king' }] } }] }));
        res.write(
          event({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: 'http', args: { url: 'https://example.com' } },
                      thoughtSignature: 'sig-http',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
        );
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'working' },
                  {
                    functionCall: { name: 'http', args: { url: 'https://example.com' } },
                    thoughtSignature: 'sig-http',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}/v1beta`;
});

afterAll(() => {
  server?.close();
});

describe('GeminiClient', () => {
  it('encodes messages and tools for generateContent and parses function calls', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test');
    const req: ChatRequest = {
      model: 'models/gemini-test',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'test' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'grep', arguments: '{"pattern":"x"}' },
              provider: { gemini: { thoughtSignature: 'sig-grep' } },
            },
          ],
        },
        { role: 'tool', name: 'grep', toolCallID: 'call_1', content: 'matched' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'http',
            description: 'make request',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
          },
        },
      ],
    };

    const out = await c.chat(req);

    expect(lastApiKeyHeader).toBe('test-key');
    expect(out.message.content).toBe('working');
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe('{"url":"https://example.com"}');
    expect(out.message.toolCalls?.[0]?.provider?.gemini?.thoughtSignature).toBe('sig-http');
    expect(lastBody?.systemInstruction).toEqual({ parts: [{ text: 'system prompt' }] });
    const contents = lastBody?.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents[1]?.parts[0]?.thoughtSignature).toBe('sig-grep');
    const tools = lastBody?.tools as Array<{
      functionDeclarations: Array<Record<string, unknown>>;
    }>;
    expect(tools[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: 'OBJECT',
      properties: { url: { type: 'STRING' } },
      required: ['url'],
    });
  });

  it('emits generationConfig from threaded temperature/max_tokens', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test', {
      temperature: 0.4,
      maxTokens: 512,
    });
    await c.chat({ model: 'models/gemini-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.generationConfig).toEqual({ temperature: 0.4, maxOutputTokens: 512 });
  });

  it('omits generationConfig when no gen opts are configured', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test');
    await c.chat({ model: 'models/gemini-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.generationConfig).toBeUndefined();
  });

  it('emits thinkingConfig to disable thinking when budget is 0', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test', { thinkingBudget: 0 });
    await c.chat({ model: 'models/gemini-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it('caps thinking and requests thought summaries for a positive budget', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test', { thinkingBudget: 256 });
    await c.chat({ model: 'models/gemini-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 256, includeThoughts: true },
    });
  });

  it('streams answer deltas, surfaces thoughts as progress, and parses tool calls', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'models/gemini-test', messages: [{ role: 'user', content: 'hi' }], stream: true },
      (d) => deltas.push(d),
    );
    // Thought summary is streamed as progress but kept out of the message.
    expect(deltas).toEqual(['pondering', 'wor', 'king']);
    expect(out.message.content).toBe('working');
    expect(out.finishReason).toBe('STOP');
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe('{"url":"https://example.com"}');
    expect(out.message.toolCalls?.[0]?.provider?.gemini?.thoughtSignature).toBe('sig-http');
  });

  it('pings the model list endpoint', async () => {
    const c = new GeminiClient(baseURL, 'test-key', 'models/gemini-test');
    await expect(c.ping()).resolves.toBeUndefined();
  });
});
