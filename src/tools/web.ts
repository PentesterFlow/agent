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

const TAG_RE = /<[^>]+>/g;
const SCRIPT_RE = /<script[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style[^>]*>[\s\S]*?<\/style>/gi;
const WS_RE = /[ \t]+/g;
const NL_RE = /\n{3,}/g;

function stripHTML(s: string): string {
  return s
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
    await gatePrivateRequest(p, parsed, signal, 'web_fetch');

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
      return formatFetchFailure(url, err, inner.aborted);
    }
    const raw = await readCapped(resp.body, FETCH_BODY_CAP);
    let text = stripHTML(raw);
    if (text.length > FETCH_TEXT_CAP) {
      text = `${text.slice(0, FETCH_TEXT_CAP)}\n[... truncated ...]`;
    }
    return `URL: ${url}\nStatus: ${resp.status} ${resp.statusText}\n\n${text}`;
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

    const inner = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combined = anySignal(signal, inner);
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 pentesterflow/0.1' },
      signal: combined,
    });
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
      return 'no results parsed (DuckDuckGo may have changed its HTML; try web_fetch on a specific URL instead)';
    }

    const out: string[] = [];
    results.forEach(([rawUrl, rawTitle, rawSnippet], i) => {
      let url = rawUrl;
      if (url.startsWith('//')) url = `https:${url}`;
      // DDG sometimes wraps results in /l/?uddg=<real>; unwrap.
      try {
        const u = new URL(url);
        if (u.host === 'duckduckgo.com' && u.pathname === '/l/') {
          const real = u.searchParams.get('uddg');
          if (real) url = decodeURIComponent(real);
        }
      } catch {
        // leave url as-is
      }
      const title = stripHTML(rawTitle);
      const snippet = stripHTML(rawSnippet);
      out.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}\n`);
    });
    return out.join('\n');
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
