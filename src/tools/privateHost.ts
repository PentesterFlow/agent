// Shared private/internal-host detection and SSRF gate for the network
// tools (web_fetch, http). Resolves the request host and flags loopback,
// RFC1918, link-local/metadata (169.254.169.254), and the IPv6 equivalents
// so the agent can't silently reach internal services or the cloud metadata
// endpoint. The gate prompts with noSessionCache so each private/internal
// request needs a fresh, non-cached approval (auto-approved under YOLO).

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
 */
export async function gatePrivateRequest(
  p: Prompter,
  parsed: URL,
  signal: AbortSignal,
  toolName: string,
): Promise<void> {
  const reason = await privateHostReason(parsed.hostname);
  if (!reason) return;
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
  if (a === 0) return 'this-network IPv4';
  return '';
}

function privateIPv6Reason(host: string): string {
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
  // NAT64 (64:ff9b::/96) carries the destination IPv4 in the low 32 bits, so a
  // request to `64:ff9b::169.254.169.254` reaches cloud metadata on an
  // IPv6-only/NAT64 network. Flag only when the embedded v4 is itself private.
  const nat64 = host.match(/^64:ff9b::(?:ffff:)?(.+)$/i);
  if (nat64?.[1]) {
    const v4 = embeddedIPv4(nat64[1]);
    const reason = v4 ? privateIPv4Reason(v4) : '';
    if (reason && v4) return `NAT64-embedded ${reason} (${v4})`;
  }
  // 6to4 (2002::/16) embeds the IPv4 in bits 16-48: 2002:AABB:CCDD::.
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
