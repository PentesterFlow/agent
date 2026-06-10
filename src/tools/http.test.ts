import { describe, expect, it, vi } from 'vitest';
import type { Prompter } from '../permission/permission.js';
import { newTarget } from '../target/target.js';
import { HTTPTool } from './http.js';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('undici', () => ({
  Agent: class Agent {},
  fetch: fetchMock,
}));

const prompter = {} as Prompter;

describe('HTTPTool', () => {
  it('does not require method in its tool schema', () => {
    const schema = new HTTPTool(newTarget()).schema();

    expect(schema).toMatchObject({ required: ['url'] });
  });

  it('summarizes URL-only calls as GET requests', () => {
    const tool = new HTTPTool(newTarget());

    expect(tool.summarize({ url: 'http://example.test' })).toMatchObject({
      summary: 'http: GET http://example.test',
      detail: 'GET http://example.test',
    });
  });

  it('defaults URL-only calls to GET at runtime', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const out = await new HTTPTool(newTarget()).run(
      { url: 'http://example.test' },
      new AbortController().signal,
      prompter,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://example.test',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('ok');
  });

  it('still requires a URL', async () => {
    await expect(
      new HTTPTool(newTarget()).run({}, new AbortController().signal, prompter),
    ).rejects.toThrow('url is required');
  });

  it('blocks a private/internal URL when the SSRF gate is denied', async () => {
    fetchMock.mockClear(); // mock is shared across tests in this file
    const ask = vi.fn().mockResolvedValue('deny');
    await expect(
      new HTTPTool(newTarget()).run(
        { url: 'http://169.254.169.254/latest/meta-data/' },
        new AbortController().signal,
        { ask },
      ),
    ).rejects.toThrow(/private\/internal URL denied/);
    // The gate is a non-cached prompt for the http tool.
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'http', noSessionCache: true }),
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows a private URL once the SSRF gate is approved', async () => {
    const ask = vi.fn().mockResolvedValue('allow-once');
    fetchMock.mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const out = await new HTTPTool(newTarget()).run(
      { url: 'http://127.0.0.1:8080/' },
      new AbortController().signal,
      { ask },
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/', expect.anything());
    expect(out).toContain('HTTP/1.1 200 OK');
  });

  it('scopes session caching to the request origin', () => {
    const tool = new HTTPTool(newTarget());
    expect(tool.permissionHints?.({ url: 'https://app.example.com/a?x=1' })).toEqual({
      cacheKey: 'https://app.example.com',
    });
    // A different host yields a different key, so one approval can't carry over.
    expect(tool.permissionHints?.({ url: 'http://169.254.169.254/' })).toEqual({
      cacheKey: 'http://169.254.169.254',
    });
  });
});
