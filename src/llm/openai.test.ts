// Integration test for the OpenAI-compatible client against a real
// in-process HTTP server. Exercises SSE streaming tool-call accumulation
// (fragments across multiple `data:` events).

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAIClient } from './openai.js';
import type { ChatRequest } from './types.js';

let server: Server;
let baseURL = '';
let lastBody: Record<string, unknown> | null = null;
let lastHeaders: Record<string, string | string[] | undefined> | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
      };
      lastBody = body as Record<string, unknown>;
      lastHeaders = req.headers;

      if (body.stream) {
        // SSE stream that fragments a tool call across two events, with
        // some plain content first.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (body.model === 'glm-stream-leak') {
          send({ choices: [{ delta: { content: 'Hi! ' } }] });
          send({ choices: [{ delta: { content: 'What can I help with?<|us' } }] });
          send({ choices: [{ delta: { content: 'er|>hello hello hello' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (body.model === 'glm-observation-leak') {
          send({ choices: [{ delta: { content: 'I will test the target.<|ob' } }] });
          send({
            choices: [
              {
                delta: {
                  content:
                    'servation|><|observation|>I got a 200 OK response and robots.txt was not found.',
                },
              },
            ],
          });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (body.model === 'reasoning-stream') {
          // Reasoning model: chain-of-thought streams first, then the answer.
          send({ choices: [{ delta: { reasoning_content: 'Let me think… ' } }] });
          send({ choices: [{ delta: { reasoning_content: 'checking the target.' } }] });
          send({ choices: [{ delta: { content: 'The answer ' } }] });
          send({ choices: [{ delta: { content: 'is 42.' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        send({ choices: [{ delta: { content: 'Working' } }] });
        send({ choices: [{ delta: { content: ' on it' } }] });
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'http', arguments: '{"url":' },
                  },
                ],
              },
            },
          ],
        });
        send({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"https://x.example.com"}' } }],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body.model === 'glm-leak') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Hi! What can I help you with today?<|user|>hello\nhello\nhello',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      if (body.model === 'glm-observation-leak') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    'I will test the target.<|observation|><|observation|>I got a 200 OK response.',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(() => {
  server?.close();
});

describe('OpenAIClient', () => {
  it('non-streaming chat returns content', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    const req: ChatRequest = { model: 'qwen-coder', messages: [{ role: 'user', content: 'hi' }] };
    const out = await c.chat(req);
    expect(out.message.content).toBe('hi');
    expect(out.finishReason).toBe('stop');
  });

  it('streams reasoning_content as visible deltas but excludes it from the message', async () => {
    const c = new OpenAIClient(baseURL, '', 'reasoning-stream');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'reasoning-stream', messages: [{ role: 'user', content: 'go' }] },
      (d) => deltas.push(d),
    );
    // Reasoning is surfaced live (so the UI leaves the "planning" phase)…
    expect(deltas.join('')).toContain('Let me think…');
    expect(deltas.join('')).toContain('The answer is 42.');
    // …but the returned message — which re-enters history — is answer-only.
    expect(out.message.content).toBe('The answer is 42.');
    expect(out.message.content).not.toContain('Let me think');
  });

  it('streaming reassembles a fragmented tool call across SSE events', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'qwen-coder', messages: [{ role: 'user', content: 'go' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('Working on it');
    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.id).toBe('call_abc');
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe('{"url":"https://x.example.com"}');
    expect(out.finishReason).toBe('tool_calls');
  });

  it('lmStudio factory uses the right default URL', () => {
    const c = OpenAIClient.lmStudio('', 'q');
    expect(c.baseURL).toBe('http://localhost:1234/v1');
    expect(c.name()).toBe('lmstudio');
  });

  it('ping succeeds when the server is up', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    await expect(c.ping()).resolves.toBeUndefined();
  });

  it('disables Kimi thinking to avoid reasoning_content/tool-call history errors', async () => {
    const c = new OpenAIClient(baseURL, 'sk-kimi', 'kimi-k2.6', 'kimi');
    await c.chat({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.thinking).toEqual({ type: 'disabled' });
  });

  it('does not send Kimi thinking toggle to Moonshot v1 models', async () => {
    const c = new OpenAIClient(baseURL, 'sk-kimi', 'moonshot-v1-8k', 'kimi');
    await c.chat({ model: 'moonshot-v1-8k', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.thinking).toBeUndefined();
  });

  it('sends a configured temperature to models that accept it', async () => {
    const c = new OpenAIClient(
      baseURL,
      '',
      'qwen-coder',
      'openai-compat',
      {},
      { temperature: 0.3 },
    );
    await c.chat({ model: 'qwen-coder', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.temperature).toBe(0.3);
  });

  it('omits temperature for temperature-locked Kimi models but still caps tokens', async () => {
    const c = new OpenAIClient(
      baseURL,
      'sk',
      'kimi-k2.6',
      'kimi',
      {},
      { temperature: 0.3, maxTokens: 2048 },
    );
    await c.chat({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] });
    // k2.6 rejects temperature != 1, so we must not send it…
    expect(lastBody?.temperature).toBeUndefined();
    // …but the response cap still applies using Kimi's preferred parameter.
    expect(lastBody?.max_completion_tokens).toBe(2048);
    expect(lastBody?.max_tokens).toBeUndefined();
  });

  it('does not send temperature or max_tokens when unconfigured', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    await c.chat({ model: 'qwen-coder', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.temperature).toBeUndefined();
    expect(lastBody?.max_tokens).toBeUndefined();
  });

  it('sends provider-specific extra headers', async () => {
    const c = new OpenAIClient(baseURL, 'sk-or', 'openrouter/auto', 'openrouter', {
      'HTTP-Referer': 'https://github.com/pentesterflow/agent',
      'X-OpenRouter-Title': 'PentesterFlow',
    });
    await c.chat({ model: 'openrouter/auto', messages: [{ role: 'user', content: 'hi' }] });

    expect(lastHeaders?.['http-referer']).toBe('https://github.com/pentesterflow/agent');
    expect(lastHeaders?.['x-openrouter-title']).toBe('PentesterFlow');
    expect(lastHeaders?.authorization).toBe('Bearer sk-or');
  });

  it('adds LM Studio stop tokens and trims leaked chat-template roles', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-leak');
    const out = await c.chat({ model: 'glm-leak', messages: [{ role: 'user', content: 'hello' }] });

    expect(out.message.content).toBe('Hi! What can I help you with today?');
    expect(lastBody?.stop).toContain('<|user|>');
    expect(lastBody?.stop).toContain('<|observation|>');
  });

  it('trims leaked LM Studio observation markers in non-streaming responses', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-observation-leak');
    const out = await c.chat({
      model: 'glm-observation-leak',
      messages: [{ role: 'user', content: 'test target' }],
    });

    expect(out.message.content).toBe('I will test the target.');
    expect(out.message.content).not.toContain('<|observation|>');
  });

  it('withholds split LM Studio role tokens during streaming', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-stream-leak');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'glm-stream-leak', messages: [{ role: 'user', content: 'hello' }] },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).toBe('Hi! What can I help with?');
    expect(out.message.content).toBe('Hi! What can I help with?');
    expect(deltas.join('')).not.toContain('<|user|>');
    expect(deltas.join('')).not.toContain('hello hello');
  });

  it('withholds split LM Studio observation markers during streaming', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-observation-leak');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'glm-observation-leak', messages: [{ role: 'user', content: 'test target' }] },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).toBe('I will test the target.');
    expect(out.message.content).toBe('I will test the target.');
    expect(deltas.join('')).not.toContain('<|observation|>');
    expect(deltas.join('')).not.toContain('200 OK');
  });
});
