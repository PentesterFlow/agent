// HTTP ingest server for the PentesterFlow Chrome extension companion.
// Binds to 127.0.0.1 only — never exposed off-host — and accepts JSON
// payloads from the extension's forwardUrl. Same instance also serves a
// tiny status endpoint so the extension popup / tooling can sanity-check.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import * as logger from '../logger/logger.js';
import type { CaptureStore } from './store.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — bigger than any reasonable single response body slice

export interface IngestServerOptions {
  store: CaptureStore;
  port: number;
  host?: string;
  token?: string;
  onEvent?: (text: string) => void;
}

export interface IngestServerHandle {
  port: number;
  host: string;
  url: string;
  token: string;
  close(): Promise<void>;
}

export function startIngestServer(opts: IngestServerOptions): Promise<IngestServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(16).toString('hex');
  const server = createServer((req, res) => handle(req, res, opts.store, token, opts.onEvent));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const boundPort =
        addr && typeof addr === 'object' && 'port' in addr ? (addr.port as number) : opts.port;
      const baseURL = `http://${host}:${boundPort}`;
      const url = baseURL;
      logger.info('burp bridge server listening', { url });
      resolve({
        port: boundPort,
        host,
        url,
        token,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: CaptureStore,
  token: string,
  onEvent?: (text: string) => void,
): void {
  if (!validLoopbackHost(req)) {
    sendJSON(res, 403, { ok: false, error: 'invalid host' });
    return;
  }

  // CORS is only exposed to Chrome-extension pages. Other browsers/local
  // processes can still send requests, but without ACAO they cannot read
  // JSON responses cross-origin.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Pentesterflow-Source, X-Pentesterflow-Token',
  );

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const parsedURL = parseRequestURL(req);
  const url = parsedURL.pathname;

  if (!authorized(req, token)) {
    sendJSON(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/status')) {
    sendJSON(res, 200, { ok: true, ...store.status() });
    return;
  }

  if (req.method === 'GET' && url === '/endpoints') {
    sendJSON(res, 200, store.listEndpoints());
    return;
  }

  if (req.method === 'GET' && url === '/requests') {
    sendJSON(res, 200, store.listRequests({ limit: 500 }));
    return;
  }

  if (req.method === 'GET' && url === '/burp/tasks') {
    sendJSON(res, 200, store.listBurpTasks());
    return;
  }

  if (req.method === 'GET' && url === '/burp/issues') {
    sendJSON(res, 200, store.listBurpIssues());
    return;
  }

  if (req.method === 'DELETE' && url === '/clear') {
    store.clear();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('method not allowed');
    return;
  }

  if (url !== '/ingest' && url !== '/snapshot' && url !== '/burp/task' && url !== '/burp/issues') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  readBody(req)
    .then((body) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      const result =
        url === '/snapshot'
          ? store.ingestSnapshot(parsed)
          : url === '/burp/task'
            ? store.ingestBurpTask(parsed)
            : url === '/burp/issues'
              ? store.ingestBurpIssue(parsed)
              : store.ingest(parsed);
      if (!result.ok) {
        sendJSON(res, 400, { ok: false, error: result.reason });
        return;
      }
      onEvent?.(eventText(url, parsed));
      sendJSON(res, 202, { ok: true });
    })
    .catch((err) => {
      logger.warn('burp bridge read error', { err: (err as Error).message });
      res.statusCode = 400;
      res.end('bad request');
    });
}

// Strip ANSI escape sequences and other C0/C1 control bytes, then bound the
// length. The values below are attacker-controlled capture data that lands in a
// kind:'system' TUI notice rendered without escaping, so a captured URL/method/
// action carrying raw ESC (OSC title-set, cursor moves, terminal hyperlinks)
// would otherwise hit the operator's terminal verbatim (M11).
function scrubControl(s: string, max = 512): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control bytes to remove them
  const cleaned = s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function eventText(url: string, parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return 'Burp bridge: received event';
  const obj = parsed as Record<string, unknown>;
  const method = scrubControl(typeof obj.method === 'string' ? obj.method : '');
  const target = scrubControl(
    typeof obj.url === 'string' ? obj.url : typeof obj.target === 'string' ? obj.target : '',
  );
  if (url === '/burp/task') {
    const action = scrubControl(typeof obj.action === 'string' ? obj.action : 'task');
    return `Burp bridge: queued ${action}${target ? ` for ${method ? `${method} ` : ''}${target}` : ''}`;
  }
  if (url === '/burp/issues') return 'Burp bridge: received issue for import';
  if (url === '/snapshot') return 'Burp bridge: received session snapshot';
  return `Burp bridge: captured request${target ? ` ${method ? `${method} ` : ''}${target}` : ''}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// Convenience: don't crash the process if a misbehaving Node ESM loader
// imports this file in a worker without store wiring. Exported for tests.
export { handle as _handleForTest };

function parseRequestURL(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1');
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['x-pentesterflow-token'];
  const headerToken = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
  return constantTimeEqual(headerToken, token);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function validLoopbackHost(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true;
  const host = raw
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
