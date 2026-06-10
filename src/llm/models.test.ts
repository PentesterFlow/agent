// Integration test for listModels — covers Ollama (/api/tags) and
// OpenAI-compatible (/models) response shapes against an in-process
// HTTP server.

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listModels } from './models.js';

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            { name: 'qwen2.5:7b' },
            { name: 'llama3.1:8b' },
            { name: '' }, // filtered out
          ],
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      // Honor Bearer auth check for the openai-compat path.
      const auth = req.headers.authorization;
      if (auth && !auth.startsWith('Bearer ')) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { id: 'qwen-coder-32b-instruct' },
            { id: 'gpt-4o-mini' },
            { id: 'kimi-k2.6' },
            { id: 'openai/gpt-oss-120b' },
            { id: 'openai/gpt-oss-20b' },
            { id: 'llama-3.3-70b-versatile' },
            { id: 'anthropic/claude-sonnet-4.5' },
            { id: 'deepseek-v4-pro' },
            { id: 'deepseek-v4-flash' },
            { id: 'deepseek-chat' },
          ],
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/gemini/models?key=gemini-key') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'models/other',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-3.5-flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-flash-lite-latest',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/gemini-embedding-001',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tags-broken') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server?.close();
});

describe('listModels', () => {
  it('parses Ollama tag list and skips blank names', async () => {
    const models = await listModels('ollama', `http://127.0.0.1:${port}`);
    expect(models).toEqual(['qwen2.5:7b', 'llama3.1:8b']);
  });

  it('parses LM Studio (openai-compat) /v1/models', async () => {
    const models = await listModels('lmstudio', `http://127.0.0.1:${port}/v1`);
    expect(models).toEqual([
      'qwen-coder-32b-instruct',
      'gpt-4o-mini',
      'kimi-k2.6',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile',
      'anthropic/claude-sonnet-4.5',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-chat',
    ]);
  });

  it('parses openai-compat /v1/models with bearer auth', async () => {
    const models = await listModels('openai-compat', `http://127.0.0.1:${port}/v1`, 'sk-fake');
    expect(models.length).toBe(10);
  });

  it('parses Kimi /v1/models with bearer auth', async () => {
    const models = await listModels('kimi', `http://127.0.0.1:${port}/v1`, 'sk-kimi');
    expect(models).toEqual(['kimi-k2.6']);
  });

  it('parses Groq /openai/v1/models with bearer auth', async () => {
    const models = await listModels('groq', `http://127.0.0.1:${port}/v1`, 'gsk-fake');
    expect(models).toEqual([
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile',
    ]);
  });

  it('parses OpenRouter /api/v1/models and prepends auto router', async () => {
    const models = await listModels('openrouter', `http://127.0.0.1:${port}/v1`, 'sk-or-fake');
    expect(models.slice(0, 3)).toEqual([
      'openrouter/auto',
      'qwen-coder-32b-instruct',
      'gpt-4o-mini',
    ]);
  });

  it('parses DeepSeek /models and prefers current model names', async () => {
    const models = await listModels('deepseek', `http://127.0.0.1:${port}/v1`, 'sk-deepseek');
    expect(models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat']);
  });

  it('parses Gemini models and sorts PentesterFlow recommendations first', async () => {
    const models = await listModels('gemini', `http://127.0.0.1:${port}/gemini`, 'gemini-key');
    expect(models).toEqual([
      'models/gemini-3.5-flash',
      'models/gemini-flash-lite-latest',
      'models/other',
    ]);
  });

  it('throws on non-200', async () => {
    await expect(listModels('ollama', `http://127.0.0.1:${port}/missing`)).rejects.toThrow(
      /returned 404/,
    );
  });

  it('throws on connection failure', async () => {
    await expect(listModels('ollama', 'http://127.0.0.1:1')).rejects.toBeInstanceOf(Error);
  });
});
