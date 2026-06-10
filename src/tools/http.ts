// http tool. Sends a single HTTP request with TLS verification disabled
// (pentest convention). Does not follow redirects — testers want to see
// the 30x.
//
// undici is used (not the global fetch) because we need to inject a
// custom dispatcher that turns off TLS verification per-request without
// polluting Node's global fetch.

import { Agent, fetch as undiciFetch } from 'undici';
import type { Prompter } from '../permission/permission.js';
import type { Target } from '../target/target.js';
import { gatePrivateRequest, parseHTTPURL } from './privateHost.js';
import { type Tool, argString } from './types.js';

const RESPONSE_BYTE_CAP = 256 * 1024;
const REQUEST_TIMEOUT_MS = 60 * 1000;

// Dispatcher shared by every http-tool call so we don't pay TLS setup
// repeatedly. rejectUnauthorized:false disables TLS verification
// per request (pentest convention).
const insecureDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
  headersTimeout: REQUEST_TIMEOUT_MS,
  bodyTimeout: REQUEST_TIMEOUT_MS,
});

export class HTTPTool implements Tool {
  private readonly target: Target;

  constructor(target: Target) {
    this.target = target;
  }

  name(): string {
    return 'http';
  }

  description(): string {
    return "Send a single HTTP/HTTPS request. The url can be absolute (https://app/api/x) or a path (/api/x); paths resolve against the active /target base URL. Useful for poking endpoints, testing IDOR, header injection, auth bypass. TLS verification is disabled. Does not follow redirects (you'll see 30x responses). Authorized targets only.";
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description:
            'HTTP method (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD). Defaults to GET.',
        },
        url: { type: 'string', description: 'Full URL including scheme.' },
        headers: {
          type: 'object',
          description: 'Request headers as a flat object {name: value}.',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string', description: 'Raw request body (optional).' },
      },
      required: ['url'],
    };
  }

  requiresPermission(): boolean {
    return true;
  }

  // Scope an "allow session" approval to the request origin (scheme + host +
  // port). Different origins re-prompt, so approving the engagement target
  // can't silently license requests to internal hosts or cloud metadata.
  permissionHints(args: Record<string, unknown>): { cacheKey: string } {
    try {
      return { cacheKey: new URL(this.resolveURL(argString(args, 'url'))).origin };
    } catch {
      // Unresolvable URL: fall back to a per-call key so nothing is cached
      // broadly. run() will surface the real error.
      return { cacheKey: argString(args, 'url') };
    }
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const method = (argString(args, 'method') || 'GET').toUpperCase();
    const url = argString(args, 'url');
    const body = argString(args, 'body');
    const headers = (args.headers ?? {}) as Record<string, unknown>;
    let detail = `${method} ${url}`;
    if (Object.keys(headers).length > 0) {
      detail += '\nheaders:';
      for (const [k, v] of Object.entries(headers)) {
        detail += `\n  ${k}: ${String(v)}`;
      }
    }
    if (body) {
      const preview = body.length > 400 ? `${body.slice(0, 400)}...` : body;
      detail += `\nbody:\n${preview}`;
    }
    return { summary: `http: ${method} ${url}`, detail };
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const method = (argString(args, 'method') || 'GET').toUpperCase();
    const rawURL = argString(args, 'url');
    const body = argString(args, 'body');
    if (!rawURL) throw new Error('url is required');

    const resolved = this.resolveURL(rawURL);
    // SSRF guard: a request whose host is (or resolves to) a private/internal
    // address requires an explicit, non-cached approval — even in YOLO.
    await gatePrivateRequest(p, parseHTTPURL(resolved), signal, 'http');

    const headers = new Headers();
    const hdrsArg = args.headers;
    if (hdrsArg && typeof hdrsArg === 'object') {
      for (const [k, v] of Object.entries(hdrsArg as Record<string, unknown>)) {
        if (typeof v === 'string') headers.set(k, v);
      }
    }
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'pentesterflow/0.1');
    }

    const init: Parameters<typeof undiciFetch>[1] = {
      method,
      headers,
      // No automatic redirect following — pentesters want to see the 30x.
      redirect: 'manual',
      signal,
      dispatcher: insecureDispatcher,
    };
    if (body) init.body = body;

    const resp = await undiciFetch(resolved, init);

    // Cap response body so a multi-MB download can't bloat the context.
    const raw = await readCapped(resp.body, RESPONSE_BYTE_CAP);

    let out = `HTTP/1.1 ${resp.status} ${resp.statusText}\n`;
    for (const [k, v] of resp.headers.entries()) {
      out += `${k}: ${v}\n`;
    }
    out += '\n';
    out += new TextDecoder().decode(raw);
    return out;
  }

  private resolveURL(raw: string): string {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (this.target.empty()) {
      throw new Error(
        `url "${raw}" is a path with no active target; set one with /target https://host or pass a full URL`,
      );
    }
    const base = this.target.baseURL().replace(/\/+$/, '');
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    return base + path;
  }
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = cap - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
