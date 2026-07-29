// Shared private/internal-host detection and SSRF gate for the network
// tools (web_fetch, http). Resolves the request host and flags loopback,
// RFC1918, link-local/metadata (169.254.169.254), and the IPv6 equivalents
// so the agent can't silently reach internal services or the cloud metadata
// endpoint. The gate prompts with noSessionCache so each private/internal
// request needs a fresh, non-cached approval (auto-approved under YOLO).
//
// H2 (AUDIT.md): The gate performs a DNS lookup to decide whether to prompt,
// then passes the *hostname* (not a pinned IP) to undici/fetch. A short-TTL
// rebinding domain can return a public IP for the gate decision and an
// internal/metadata IP on the actual connect. This is an accepted design
// decision (see triage table in AUDIT.md and PROJECT.md "without limits"
// philosophy). Reaching internal services via rebinding is frequently a
// legitimate testing goal. We do NOT pin IPs or hard-block. At most we
// surface the reason in the permission prompt (already done) and tool output.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Prompter } from '../permission/permission.js';

/** Parse and validate an http(s) URL. Throws on a malformed URL or a
 *  non-http(s) scheme (file:, gopher:, etc. are common SSRF vectors). */
export function parseHTTPURL(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol || '(none)'}`);
  }
  return parsed;
}

/**
 * Prompt before a request whose host is (or resolves to) a private/internal
 * address. Returns immediately for public hosts. noSessionCache means the
 * prompt fires on every such request and is never silently re-granted for the
 * session (auto-approved under YOLO, like every gate). `toolName` is the tool
 * surfacing the request (for the modal). Throws on deny.
 *
 * Returns the reason string (if any) so callers can surface a non-blocking
 * trace in tool output / transcript. This is the recommended "at most a notice"
 * mitigation for H2 (DNS rebinding) per AUDIT.md — we still allow the request
 * after explicit approval and never pin or block.
 */
export async function gatePrivateRequest(
  p: Prompter,
  parsed: URL,
  signal: AbortSignal,
  toolName: string,
): Promise<string> {
  const reason = await privateHostReason(parsed.hostname);
  if (!reason) return '';
  const decision = await p.ask(
    {
      tool: toolName,
      summary: `${toolName}: private/internal URL ${parsed.href}`,
      detail: `host: ${parsed.hostname}\nreason: ${reason}\n\nThis points at a private/internal/metadata address, a classic SSRF target. Approve only if this host is intentionally in scope for the engagement.`,
      noSessionCache: true,
    },
    signal,
  );
  if (decision === 'deny') {
    throw new Error(`request to private/internal URL denied: ${parsed.href}`);
  }
  return reason;
}

/** Returns a human-readable reason if the host is private/internal, else ''.
 *  Resolves DNS names so a public name pointing at an internal IP is caught. */
export async function privateHostReason(hostname: string): Promise<string> {
  // Strip brackets and a trailing FQDN dot so `localhost.` / `127.0.0.1.` are
  // normalized like their dotless forms before any name/IP check.
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost name';
  const kind = isIP(host);
  if (kind === 4) return privateIPv4Reason(host);
  if (kind === 6) return privateIPv6Reason(host);
  try {
    const resolved = await lookup(host, { all: true, verbatim: true });
    for (const addr of resolved) {
      const reason =
        addr.family === 4 ? privateIPv4Reason(addr.address) : privateIPv6Reason(addr.address);
      if (reason) return `DNS resolves to ${reason} (${addr.address})`;
    }
  } catch {
    // Let the caller's fetch surface DNS failures with its normal diagnostics.
  }
  return '';
}

function privateIPv4Reason(host: string): string {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return '';
  const [a, b] = parts;
  if (a === undefined || b === undefined) return '';
  if (a === 10) return 'RFC1918 private IPv4';
  if (a === 127) return 'loopback IPv4';
  if (a === 169 && b === 254) return 'link-local/metadata IPv4';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private IPv4';
  if (a === 192 && b === 168) return 'RFC1918 private IPv4';
  // RFC 6598 shared address space (100.64.0.0/10). Not publicly routable, and in
  // practice this is where real internal infrastructure lives: Tailscale/WireGuard
  // overlays (incl. the 100.100.100.100 MagicDNS resolver), carrier-grade NAT, and
  // several cloud providers' internal service endpoints. Without this a web_fetch
  // at a tailnet host is reached silently, with no gate prompt.
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return 'RFC6598 shared address space IPv4';
  if (a === 0) return 'this-network IPv4';
  return '';
}

function privateIPv6Reason(host: string): string {
  // Expand all spellings (compressed + fully expanded) to 8 hextets so
  // `0:0:0:0:0:0:0:1` and `::1` hit the same checks. Literal-string matches
  // alone miss expanded loopback / IPv4-mapped forms and silently skip the
  // private-host permission prompt.
  const hextets = expandIPv6(host);
  if (hextets) {
    // Loopback ::1
    if (hextets.every((h, i) => (i === 7 ? h === 1 : h === 0))) return 'loopback IPv6';
    // Unspecified ::
    if (hextets.every((h) => h === 0)) return 'unspecified IPv6';
    // IPv4-mapped ::ffff:a.b.c.d (and expanded 0:0:0:0:0:ffff:…)
    if (
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0xffff
    ) {
      const hi = hextets[6] ?? 0;
      const lo = hextets[7] ?? 0;
      const dotted = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      return privateIPv4Reason(dotted) || '';
    }
    // NAT64 64:ff9b::/96 — embedded v4 in low 32 bits
    if (
      hextets[0] === 0x64 &&
      hextets[1] === 0xff9b &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0
    ) {
      const hi = hextets[6] ?? 0;
      const lo = hextets[7] ?? 0;
      const dotted = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      const reason = privateIPv4Reason(dotted);
      if (reason) return `NAT64-embedded ${reason} (${dotted})`;
    }
    // 6to4 2002::/16 — IPv4 in bits 16-48
    if (hextets[0] === 0x2002) {
      const h1 = hextets[1] ?? 0;
      const h2 = hextets[2] ?? 0;
      const v4 = hextetsToIPv4(h1.toString(16), h2.toString(16));
      const reason = v4 ? privateIPv4Reason(v4) : '';
      if (reason && v4) return `6to4-embedded ${reason} (${v4})`;
    }
    const h0 = hextets[0] ?? 0;
    // Link-local fe80::/10
    if ((h0 & 0xffc0) === 0xfe80) return 'link-local IPv6';
    // Unique local fc00::/7
    if ((h0 & 0xfe00) === 0xfc00) return 'unique-local IPv6';
    return '';
  }

  // Fallback for odd forms expandIPv6 couldn't parse: keep prior compressed
  // string matches so we never regress known good paths.
  const mappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDotted?.[1]) return privateIPv4Reason(mappedDotted[1]) || '';
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const dotted = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      return privateIPv4Reason(dotted) || '';
    }
  }
  const nat64 = host.match(/^64:ff9b::(?:ffff:)?(.+)$/i);
  if (nat64?.[1]) {
    const v4 = embeddedIPv4(nat64[1]);
    const reason = v4 ? privateIPv4Reason(v4) : '';
    if (reason && v4) return `NAT64-embedded ${reason} (${v4})`;
  }
  const sixToFour = host.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})\b/i);
  if (sixToFour?.[1] && sixToFour[2]) {
    const v4 = hextetsToIPv4(sixToFour[1], sixToFour[2]);
    const reason = v4 ? privateIPv4Reason(v4) : '';
    if (reason && v4) return `6to4-embedded ${reason} (${v4})`;
  }
  if (host === '::1') return 'loopback IPv6';
  if (host === '::') return 'unspecified IPv6';
  if (host.startsWith('fe80:')) return 'link-local IPv6';
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'unique-local IPv6';
  return '';
}

/**
 * Expand an IPv6 literal into 8 numeric hextets, or null if unparseable.
 * Handles compressed `::`, dotted IPv4 tails (`::ffff:127.0.0.1`), and fully
 * expanded forms. Does not resolve zone ids (`%eth0`).
 */
function expandIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  // Zone id (fe80::1%lo0) — strip for classification.
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);

  // Replace a trailing dotted IPv4 with two hextets.
  const v4tail = h.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4tail?.[1] && v4tail[2]) {
    const parts = v4tail[2].split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
      return null;
    }
    const [a, b, c, d] = parts as [number, number, number, number];
    h = `${v4tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  if (h.includes('::')) {
    const [leftRaw, rightRaw] = h.split('::');
    if (h.indexOf('::') !== h.lastIndexOf('::')) return null; // multiple ::
    const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
    const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const filled = [...left, ...Array(missing).fill('0'), ...right];
    if (filled.length !== 8) return null;
    const nums = filled.map((x) => Number.parseInt(x, 16));
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
    return nums;
  }

  const parts = h.split(':');
  if (parts.length !== 8) return null;
  const nums = parts.map((x) => Number.parseInt(x, 16));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

/** Extract a trailing embedded IPv4 from an IPv6 tail, dotted or hex form. */
function embeddedIPv4(tail: string): string | null {
  const dotted = tail.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted?.[1]) return dotted[1];
  const hex = tail.match(/([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex?.[1] && hex[2]) return hextetsToIPv4(hex[1], hex[2]);
  return null;
}

/** Combine two 16-bit hextets into a dotted IPv4, or null on bad input. */
function hextetsToIPv4(hiHex: string, loHex: string): string | null {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}
