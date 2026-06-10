import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlwaysDeny } from '../permission/permission.js';
import type { Prompter } from '../permission/permission.js';
import { WebFetchTool } from './web.js';

const prompter = {} as Prompter;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebFetchTool', () => {
  it('returns readable text for successful fetches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html><body><h1>Hello</h1><script>x()</script></body></html>'),
      ),
    );

    const out = await new WebFetchTool().run(
      { url: 'https://example.com' },
      new AbortController().signal,
      prompter,
    );

    expect(out).toContain('URL: https://example.com');
    expect(out).toContain('Status: 200');
    expect(out).toContain('Hello');
    expect(out).not.toContain('<h1>');
    expect(out).not.toContain('x()');
  });

  it('explains HackerOne platform DNS failures with a public program URL hint', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND platform.hackerone.com'), {
      code: 'ENOTFOUND',
      hostname: 'platform.hackerone.com',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause });
      }),
    );

    const out = await new WebFetchTool().run(
      { url: 'https://platform.hackerone.com/hackerone/policy_scopes' },
      new AbortController().signal,
      prompter,
    );

    expect(out).toContain('ERROR: fetch failed');
    expect(out).toContain('Code: ENOTFOUND');
    expect(out).toContain('platform.hackerone.com is not a public HackerOne program host');
    expect(out).toContain('https://hackerone.com/hackerone');
  });

  it('rethrows when the caller aborts the request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('aborted');
      }),
    );

    await expect(
      new WebFetchTool().run({ url: 'https://example.com' }, ctl.signal, prompter),
    ).rejects.toThrow('aborted');
  });

  it('prompts before fetching private or local URLs', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      new WebFetchTool().run(
        { url: 'http://127.0.0.1:3000/status' },
        new AbortController().signal,
        new AlwaysDeny(),
      ),
    ).rejects.toThrow(/private\/internal URL denied/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not automatically follow redirects', async () => {
    const fetch = vi.fn(
      async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }),
    );
    vi.stubGlobal('fetch', fetch);

    await new WebFetchTool().run(
      { url: 'https://example.com/redirect' },
      new AbortController().signal,
      prompter,
    );

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/redirect',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('prompts before fetching IPv4-mapped IPv6 private URLs', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      new WebFetchTool().run(
        { url: 'http://[::ffff:169.254.169.254]/latest/meta-data/' },
        new AbortController().signal,
        new AlwaysDeny(),
      ),
    ).rejects.toThrow(/private\/internal URL denied/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects non-HTTP URL schemes', async () => {
    await expect(
      new WebFetchTool().run({ url: 'file:///etc/passwd' }, new AbortController().signal, prompter),
    ).rejects.toThrow(/unsupported URL scheme/);
  });
});
