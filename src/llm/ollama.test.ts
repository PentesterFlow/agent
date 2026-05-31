// Integration test for the Ollama client against a real in-process HTTP
// server. We don't mock fetch — we want to exercise the actual streaming
// + parsing path end-to-end.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaClient } from './ollama.js';
import type { ChatRequest } from './types.js';

let server: Server;
let baseURL = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    // Read request body, decide based on the model field.
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
      };

      if (body.model === 'streaming-with-tool') {
        // Tool call delivered in a mid-stream chunk; final chunk carries done:true with empty content.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: 'Looking up... ' } })}\n`,
        );
        res.write(
          `${JSON.stringify({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'http', arguments: { url: 'https://x.example.com' } } },
              ],
            },
          })}\n`,
        );
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`);
        return;
      }

      if (body.model === 'streaming-malformed-chunk') {
        // Insert a malformed line between two valid ones — should be
        // dropped + logged, but the surrounding chunks should still parse.
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'hi' } })}\n`);
        res.write('{ not valid json\n');
        res.end(
          `${JSON.stringify({ message: { role: 'assistant', content: ' there' }, done: true })}\n`,
        );
        return;
      }

      if (body.model === 'content-json-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: JSON.stringify({
                name: 'http',
                arguments: { method: 'GET', url: 'https://x.example.com' },
              }),
            },
            done: true,
          }),
        );
        return;
      }

      if (body.model === 'content-fenced-tool-calls') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: `\`\`\`json
${JSON.stringify({
  tool_calls: [
    {
      function: {
        name: 'http',
        arguments: '{"url":"https://x.example.com/a","method":"POST"}',
      },
    },
  ],
})}
\`\`\``,
            },
            done: true,
          }),
        );
        return;
      }

      if (body.model === 'streaming-content-json-tool-call') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({ message: { role: 'assistant', content: '{"name":"http",' } })}\n`,
        );
        res.write(
          `${JSON.stringify({
            message: {
              role: 'assistant',
              content: '"arguments":{"url":"https://x.example.com/stream"}}',
            },
            done: true,
          })}\n`,
        );
        return;
      }

      // Default non-streaming response.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: { role: 'assistant', content: 'hello back' },
          done: true,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

describe('OllamaClient', () => {
  it('non-streaming chat returns the assembled message', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    const req: ChatRequest = {
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = await c.chat(req);
    expect(out.message.content).toBe('hello back');
    expect(out.finishReason).toBe('stop');
  });

  it('streaming accumulates tool calls from intermediate chunks', async () => {
    const c = new OllamaClient(baseURL, 'streaming-with-tool');
    const deltas: string[] = [];
    const req: ChatRequest = {
      model: 'streaming-with-tool',
      messages: [{ role: 'user', content: 'do it' }],
    };
    const out = await c.chatStream(req, (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Looking up... ');
    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.finishReason).toBe('tool_calls');
  });

  it('streaming survives a malformed chunk and keeps the surrounding text', async () => {
    const c = new OllamaClient(baseURL, 'streaming-malformed-chunk');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'streaming-malformed-chunk', messages: [{ role: 'user', content: 'x' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('hi there');
    expect(out.message.content).toBe('hi there');
  });

  it('non-streaming parses JSON content tool calls for Ollama models that do not emit native tool_calls', async () => {
    const c = new OllamaClient(baseURL, 'content-json-tool-call');
    const out = await c.chat({
      model: 'content-json-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"method":"GET","url":"https://x.example.com"}',
    );
    expect(out.finishReason).toBe('tool_calls');
  });

  it('non-streaming parses fenced tool_calls content with string arguments', async () => {
    const c = new OllamaClient(baseURL, 'content-fenced-tool-calls');
    const out = await c.chat({
      model: 'content-fenced-tool-calls',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'http', description: 'http tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/a","method":"POST"}',
    );
  });

  it('streaming parses JSON content tool calls when native tool_calls are absent', async () => {
    const c = new OllamaClient(baseURL, 'streaming-content-json-tool-call');
    const deltas: string[] = [];
    const out = await c.chatStream(
      {
        model: 'streaming-content-json-tool-call',
        messages: [{ role: 'user', content: 'fetch it' }],
        tools: [
          {
            type: 'function',
            function: { name: 'http', description: 'http tool', parameters: {} },
          },
        ],
      },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).toBe(
      '{"name":"http","arguments":{"url":"https://x.example.com/stream"}}',
    );
    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe(
      '{"url":"https://x.example.com/stream"}',
    );
    expect(out.finishReason).toBe('tool_calls');
  });

  it('does not execute JSON content for unknown tools', async () => {
    const c = new OllamaClient(baseURL, 'content-json-tool-call');
    const out = await c.chat({
      model: 'content-json-tool-call',
      messages: [{ role: 'user', content: 'fetch it' }],
      tools: [
        {
          type: 'function',
          function: { name: 'shell', description: 'shell tool', parameters: {} },
        },
      ],
    });

    expect(out.message.toolCalls).toBeUndefined();
    expect(out.finishReason).toBe('stop');
  });

  it('ping succeeds against a live server', async () => {
    const c = new OllamaClient(baseURL, 'qwen2.5:7b');
    await expect(c.ping()).resolves.toBeUndefined();
  });

  it('ping rejects on connection failure', async () => {
    const c = new OllamaClient('http://127.0.0.1:1', 'qwen2.5:7b');
    await expect(c.ping()).rejects.toBeInstanceOf(Error);
  });
});
