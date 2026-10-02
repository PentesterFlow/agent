import { describe, expect, it } from 'vitest';
import { parseHTTPURL, privateHostReason } from './privateHost.js';

describe('privateHostReason', () => {
  it('flags compressed loopback and unspecified IPv6', async () => {
    expect(await privateHostReason('::1')).toBe('loopback IPv6');
    expect(await privateHostReason('::')).toBe('unspecified IPv6');
  });

  it('flags fully expanded loopback (was a silent gate bypass)', async () => {
    expect(await privateHostReason('0:0:0:0:0:0:0:1')).toBe('loopback IPv6');
    expect(await privateHostReason('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(
      'loopback IPv6',
    );
  });

  it('flags expanded IPv4-mapped private addresses', async () => {
    expect(await privateHostReason('0:0:0:0:0:ffff:127.0.0.1')).toMatch(/loopback/i);
    expect(await privateHostReason('0:0:0:0:0:ffff:a9fe:a9fe')).toMatch(/link-local|metadata/i);
    expect(await privateHostReason('::ffff:127.0.0.1')).toMatch(/loopback/i);
    expect(await privateHostReason('::ffff:a9fe:a9fe')).toMatch(/link-local|metadata/i);
  });

  it('flags expanded unique-local and link-local', async () => {
    expect(await privateHostReason('fc00:0:0:0:0:0:0:1')).toBe('unique-local IPv6');
    expect(await privateHostReason('fe80:0:0:0:0:0:0:1')).toBe('link-local IPv6');
  });

  it('does not flag public IPv6', async () => {
    expect(await privateHostReason('2001:4860:4860::8888')).toBe('');
    expect(await privateHostReason('2606:4700:4700::1111')).toBe('');
  });

  it('still flags classic private IPv4', async () => {
    expect(await privateHostReason('127.0.0.1')).toBe('loopback IPv4');
    expect(await privateHostReason('169.254.169.254')).toMatch(/metadata|link-local/i);
    expect(await privateHostReason('10.0.0.1')).toMatch(/RFC1918/i);
  });
});

describe('privateHostReason IPv4 boundary cases', () => {
  const cases: Array<{ host: string; want: boolean; note?: string }> = [
    // this-network
    { host: '0.0.0.0', want: true },

    // RFC 6598 shared address space (100.64.0.0/10)
    { host: '100.64.0.1', want: true, note: 'RFC 6598 lower bound' },
    { host: '100.100.100.100', want: true, note: 'tailscale MagicDNS resolver' },
    { host: '100.127.255.255', want: true, note: 'RFC 6598 upper bound' },

    // adjacent public space that must NOT be flagged
    { host: '100.63.255.255', want: false, note: 'just below 100.64/10' },
    { host: '100.128.0.1', want: false, note: 'just above 100.64/10' },
    { host: '8.8.8.8', want: false },
    { host: '172.16.0.1', want: true },
    { host: '172.32.0.1', want: false, note: 'just above RFC1918 172.16/12' },
    { host: '172.15.0.1', want: false, note: 'just below RFC1918 172.16/12' },
  ];

  for (const { host, want, note } of cases) {
    const label = note ? `${host} (${note})` : host;
    it(`${want ? 'flags' : 'allows'} ${label}`, async () => {
      const reason = await privateHostReason(host);
      expect(Boolean(reason)).toBe(want);
    });
  }
});

describe('privateHostReason hostname normalization', () => {
  it('normalizes a trailing FQDN dot', async () => {
    expect(await privateHostReason('localhost.')).toBeTruthy();
  });

  it('normalizes bracketed IPv6', async () => {
    expect(await privateHostReason('[::1]')).toBeTruthy();
  });
});

describe('parseHTTPURL', () => {
  it('accepts http and https', () => {
    expect(parseHTTPURL('http://example.com/').protocol).toBe('http:');
    expect(parseHTTPURL('https://example.com/').protocol).toBe('https:');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => parseHTTPURL('file:///etc/passwd')).toThrow(/unsupported URL scheme/);
    expect(() => parseHTTPURL('gopher://example.com/')).toThrow(/unsupported URL scheme/);
  });

  it('rejects a malformed URL', () => {
    expect(() => parseHTTPURL('not a url')).toThrow(/invalid URL/);
  });
});
