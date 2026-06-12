// web_fetch + web_search tools. web_fetch returns readable text with
// HTML tags stripped; web_search hits DuckDuckGo's HTML endpoint and
// parses the top results.

import type { Prompter } from '../permission/permission.js';
import { gatePrivateRequest, parseHTTPURL } from './privateHost.js';
import { type Tool, argString } from './types.js';

const FETCH_TIMEOUT_MS = 30 * 1000;
const FETCH_BODY_CAP = 512 * 1024;
const SEARCH_BODY_CAP = 1024 * 1024;
const FETCH_TEXT_CAP = 40 * 1024;
// Cap the raw HTML fed to the regex passes below. stripHTML runs 5 global
// regexes (some with `[\s\S]*?`) which are vulnerable to catastrophic
// backtracking on pathological markup; bounding the input keeps the worst case
// linear-ish. The downstream FETCH_TEXT_CAP (40KB) means text past this point
// would be discarded anyway.
const STRIP_INPUT_CAP = 256 * 1024;

// Small TTL + LRU cache so repeated web_fetch/web_search calls (the model often
// re-fetches the same advisory or re-runs a query) skip the network round-trip.
// Only successful results are cached. Keyed by `fetch:<url>` / `search:<query>`.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  value: string;
  expires: number;
}

let resultCache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | undefined {
  const entry = resultCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    resultCache.delete(key);
    return undefined;
  }
  // Re-insert so the most-recently-used key moves to the end (Map preserves
  // insertion order; eviction drops from the front).
  resultCache.delete(key);
  resultCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  resultCache.delete(key);
  resultCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** Reset the web result cache. Exposed for tests so cached entries don't leak
 *  between cases (and so suites can exercise the cold path deterministically). */
export function clearWebCache(): void {
  resultCache = new Map<string, CacheEntry>();
}

const TAG_RE = /<[^>]+>/g;
const SCRIPT_RE = /<script[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style[^>]*>[\s\S]*?<\/style>/gi;
const WS_RE = /[ \t]+/g;
const NL_RE = /\n{3,}/g;

function stripHTML(s: string): string {
  const input = s.length > STRIP_INPUT_CAP ? s.slice(0, STRIP_INPUT_CAP) : s;
  return input
    .replace(SCRIPT_RE, '')
    .replace(STYLE_RE, '')
    .replace(TAG_RE, '')
    .replace(WS_RE, ' ')
    .replace(NL_RE, '\n\n')
    .trim();
}

export class WebFetchTool implements Tool {
  name(): string {
    return 'web_fetch';
  }
  description(): string {
    return 'Fetch a public web page and return its readable text (HTML tags stripped). Use for CVE lookups, exploit-DB pages, vendor advisories, technical articles.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (http/https).' },
      },
      required: ['url'],
    };
  }
  requiresPermission(): boolean {
    return false;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const url = argString(args, 'url');
    if (!url) throw new Error('url is required');
    const parsed = parseHTTPURL(url);
    const privateReason = await gatePrivateRequest(p, parsed, signal, 'web_fetch');

    // Cache-check after the private-host gate so a repeat private fetch still
    // re-prompts rather than silently replaying a cached body.
    const cacheKey = `fetch:${parsed.toString()}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    const inner = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combined = anySignal(signal, inner);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 pentesterflow/0.1 (+research)',
        },
        signal: combined,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      // Failures are not cached.
      return formatFetchFailure(url, err, inner.aborted);
    }
    const raw = await readCapped(resp.body, FETCH_BODY_CAP);
    let text = stripHTML(raw);
    if (text.length > FETCH_TEXT_CAP) {
      text = `${text.slice(0, FETCH_TEXT_CAP)}\n[... truncated ...]`;
    }
    let result = `URL: ${url}\nStatus: ${resp.status} ${resp.statusText}\n\n${text}`;
    if (privateReason) {
      result = `note: private/internal host approved for this fetch (reason: ${privateReason})\n\n${result}`;
    }
    cacheSet(cacheKey, result);
    return result;
  }
}

function formatFetchFailure(url: string, err: unknown, timedOut: boolean): string {
  const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const detail = cause?.message ?? message;
  const lines = [
    `URL: ${url}`,
    'ERROR: fetch failed',
    `Reason: ${timedOut ? 'request timed out' : detail}`,
  ];
  if (cause?.code) lines.push(`Code: ${cause.code}`);
  const host = hostnameOf(url);
  if (host) lines.push(`Host: ${host}`);
  const hint = fetchFailureHint(url, cause?.code);
  if (hint) lines.push('', hint);
  return lines.join('\n');
}

function fetchFailureHint(url: string, code: string | undefined): string {
  const host = hostnameOf(url);
  if (host === 'platform.hackerone.com') {
    const handle = hackerOneHandleFromPlatformPath(url);
    const programURL = handle
      ? `https://hackerone.com/${handle}`
      : 'https://hackerone.com/<program>';
    return [
      'Hint: platform.hackerone.com is not a public HackerOne program host.',
      `Try the public program page instead: ${programURL}`,
      'For scope data, use the public program page or HackerOne API with valid credentials.',
    ].join('\n');
  }
  if (code === 'ENOTFOUND') return 'Hint: DNS lookup failed. Check the hostname or try web_search.';
  if (code === 'ECONNREFUSED') return 'Hint: connection refused. Check the scheme, host, and port.';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return 'Hint: TLS certificate validation failed. Use the http tool or curl when you need TLS-disabled probing.';
  }
  return '';
}

function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hackerOneHandleFromPlatformPath(raw: string): string {
  try {
    const parts = new URL(raw).pathname.split('/').filter(Boolean);
    return parts[0] ?? '';
  } catch {
    return '';
  }
}

// DuckDuckGo HTML result anchor. JS RegExp uses different flag
// conventions, so we use `s` (dotall) +
// `i` (case-insensitive) explicitly.
const DDG_RESULT_RE =
  /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

// Degraded fallback: any anchor with an href + text, used only when the
// structured result regex matches nothing.
const ANCHOR_RE = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

/** Normalize a DDG result href: protocol-relative → https, unwrap /l/?uddg=. */
function normalizeDDGUrl(rawUrl: string): string {
  let url = rawUrl;
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    const u = new URL(url);
    if (u.host === 'duckduckgo.com' && u.pathname === '/l/') {
      const real = u.searchParams.get('uddg');
      if (real) url = decodeURIComponent(real);
    }
  } catch {
    // leave url as-is
  }
  return url;
}

/**
 * Extract up to 10 distinct http(s) result links from raw DDG HTML by scanning
 * every anchor. Drops DDG's own nav/relative anchors and empty-text links.
 */
function extractAnchorResults(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null = ANCHOR_RE.exec(body);
  while (m !== null && out.length < 10) {
    const url = normalizeDDGUrl(m[1] ?? '');
    const title = stripHTML(m[2] ?? '');
    m = ANCHOR_RE.exec(body);
    if (!title) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push([url, title]);
  }
  return out;
}

export class WebSearchTool implements Tool {
  name(): string {
    return 'web_search';
  }
  description(): string {
    return 'Search the web (via DuckDuckGo) and return a list of result titles, URLs, and snippets. Use for finding CVEs, exploits, technique writeups, vendor docs.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    };
  }
  requiresPermission(): boolean {
    return false;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, _p: Prompter): Promise<string> {
    const query = argString(args, 'query');
    if (!query) throw new Error('query is required');
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const cacheKey = `search:${query.trim()}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    const inner = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combined = anySignal(signal, inner);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 pentesterflow/0.1' },
        signal: combined,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      // Surface a structured failure like web_fetch instead of throwing raw.
      return formatFetchFailure(endpoint, err, inner.aborted);
    }
    const body = await readCapped(resp.body, SEARCH_BODY_CAP);

    const results: Array<[string, string, string]> = [];
    // Stateful global regex — reset and iterate.
    DDG_RESULT_RE.lastIndex = 0;
    let m: RegExpExecArray | null = DDG_RESULT_RE.exec(body);
    while (m !== null && results.length < 10) {
      results.push([m[1] ?? '', m[2] ?? '', m[3] ?? '']);
      m = DDG_RESULT_RE.exec(body);
    }

    if (results.length === 0) {
      // Structured parse found nothing. If the body is non-empty the markup
      // likely changed — fall back to raw anchor extraction and say so, rather
      // than silently reporting zero results.
      if (body.trim().length > 0) {
        const anchors = extractAnchorResults(body);
        if (anchors.length > 0) {
          const out = anchors.map(([url, title], i) => `${i + 1}. ${title}\n   ${url}\n`);
          const result = `degraded results (DuckDuckGo markup changed; extracted raw links):\n\n${out.join('\n')}`;
          cacheSet(cacheKey, result);
          return result;
        }
      }
      return 'no results parsed (DuckDuckGo may have changed its HTML; try web_fetch on a specific URL instead)';
    }

    const out: string[] = [];
    results.forEach(([rawUrl, rawTitle, rawSnippet], i) => {
      const url = normalizeDDGUrl(rawUrl);
      const title = stripHTML(rawTitle);
      const snippet = stripHTML(rawSnippet);
      out.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}\n`);
    });
    const result = out.join('\n');
    cacheSet(cacheKey, result);
    return result;
  }
}

// ---------- helpers ----------

async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf8', { fatal: false });
  let out = '';
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = cap - total;
    if (value.byteLength > remaining) {
      out += decoder.decode(value.subarray(0, remaining), { stream: false });
      total += remaining;
      await reader.cancel();
      break;
    }
    out += decoder.decode(value, { stream: true });
    total += value.byteLength;
  }
  out += decoder.decode();
  return out;
}

/** Compose two abort signals: aborts when either fires. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as { any: (s: AbortSignal[]) => AbortSignal }).any([a, b]);
  }
  const ctl = new AbortController();
  const trip = () => ctl.abort();
  if (a.aborted) ctl.abort();
  else a.addEventListener('abort', trip, { once: true });
  if (b.aborted) ctl.abort();
  else b.addEventListener('abort', trip, { once: true });
  return ctl.signal;
}
