// pentesterflow-browser-mcp — standalone MCP stdio server that pairs with
// the PentesterFlow Chrome extension companion.
//
// What this is, in one line: a small Node process you put in your MCP
// client's mcp.json, that hosts a local ingest HTTP endpoint for the
// browser extension AND re-exposes the captured traffic as MCP tools so
// any MCP-aware client (Cursor, the pentesterflow agent itself, ...) can
// read it the same way.
//
//   Cursor       ──┐
//   other clients──┼── stdio MCP ──► this process ──► CaptureStore ◄── HTTP /ingest ──── Chrome extension
//   pentesterflow─┘
//
// The ingest HTTP server binds 127.0.0.1 only and requires a per-process
// token in X-Pentesterflow-Token.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as logger from '../logger/logger.js';
import { startIngestServer } from './server.js';
import { CaptureStore } from './store.js';

const SERVER_NAME = 'pentesterflow-browser';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PORT = 9999;

interface ParsedArgs {
  port: number;
  maxEntries: number;
  logPath: string;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    port: DEFAULT_PORT,
    maxEntries: 5000,
    logPath: '',
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    switch (a) {
      case '--port': {
        const n = Number.parseInt(next(), 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) out.port = n;
        break;
      }
      case '--max-entries': {
        const n = Number.parseInt(next(), 10);
        if (Number.isFinite(n) && n >= 100) out.maxEntries = n;
        break;
      }
      case '--log':
        out.logPath = next();
        break;
      case '-h':
      case '--help':
        out.showHelp = true;
        break;
    }
  }
  return out;
}

function printHelp(): void {
  // Write help to stderr — stdout is reserved for MCP framing.
  process.stderr.write(`pentesterflow-browser-mcp ${SERVER_VERSION}

Standalone MCP stdio server that bridges the PentesterFlow Chrome extension
to any MCP-aware client (Cursor, pentesterflow, ...).

Usage:
  pentesterflow-browser-mcp [flags]

Flags:
  --port <n>          ingest HTTP port (default ${DEFAULT_PORT}, 127.0.0.1 only)
  --max-entries <n>   max captured requests retained (default 5000, min 100)
  --log <path>        write structured logs here (default off)
  -h, --help          this help

In your MCP client's mcp.json:
  {
    "mcpServers": {
      "pentesterflow-browser": {
        "command": "pentesterflow-browser-mcp",
        "args": []
      }
    }
  }
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return 0;
  }
  logger.init(args.logPath);
  logger.info('browser-mcp startup', { port: args.port, maxEntries: args.maxEntries });

  // Store + ingest HTTP server. Bind 127.0.0.1 only.
  const store = new CaptureStore({ maxEntries: args.maxEntries });
  let ingestUrl = '';
  try {
    const handle = await startIngestServer({ store, port: args.port });
    ingestUrl = handle.url;
    process.stderr.write(
      `[pentesterflow-browser-mcp] ingest listening at ${handle.url}/ingest\n[pentesterflow-browser-mcp] token: ${handle.token}\n[pentesterflow-browser-mcp] configure the Chrome extension with this base URL and token.\n`,
    );
    const close = async () => {
      logger.info('browser-mcp shutdown');
      await handle.close();
    };
    process.on('SIGINT', () => {
      void close().finally(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      void close().finally(() => process.exit(0));
    });
  } catch (err) {
    process.stderr.write(
      `[pentesterflow-browser-mcp] failed to start ingest server on :${args.port}: ${(err as Error).message}\n`,
    );
    return 1;
  }

  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ---- Tools ----

  mcp.registerTool(
    'browser_capture_status',
    {
      title: 'Browser capture: status',
      description:
        'Show counts (requests / endpoints / snapshots) and last-activity time for traffic captured by the PentesterFlow Chrome extension. Call this first to confirm the extension is connected and forwarding.',
      inputSchema: {},
    },
    async () => {
      const s = store.status();
      return textResult(
        JSON.stringify(
          {
            ingestUrl: ingestUrl ? `${ingestUrl}/ingest` : null,
            requests: s.requestCount,
            endpoints: s.endpointCount,
            snapshots: s.snapshotCount,
            lastActivityAt: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
          },
          null,
          2,
        ),
      );
    },
  );

  mcp.registerTool(
    'browser_capture_endpoints',
    {
      title: 'Browser capture: endpoints',
      description:
        'List unique endpoints (METHOD + path-without-query) observed by the extension, with the set of query and body parameter names ever seen for each. Use this to plan IDOR / injection / fuzz targets without re-crawling.',
      inputSchema: {
        url_contains: z
          .string()
          .optional()
          .describe('Filter to endpoints whose URL contains this substring.'),
        method: z.string().optional().describe('Filter to a single HTTP method (GET, POST, ...).'),
      },
    },
    async (input) => {
      const eps = store.listEndpoints({
        urlSubstr: input.url_contains || undefined,
        method: input.method || undefined,
      });
      if (eps.length === 0) {
        return textResult(
          'No endpoints captured yet. Confirm the extension is running with capture enabled and the scope regex matches the target.',
        );
      }
      return textResult(JSON.stringify(eps, null, 2));
    },
  );

  mcp.registerTool(
    'browser_capture_requests',
    {
      title: 'Browser capture: recent requests',
      description:
        'List recent captured requests (most-recent first) with id, method, url, status. Use the returned id with browser_capture_get to retrieve full headers + body for a specific request.',
      inputSchema: {
        url_contains: z.string().optional().describe('Filter by URL substring.'),
        method: z.string().optional().describe('Filter to a single HTTP method.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50).'),
      },
    },
    async (input) => {
      const rows = store.listRequests({
        urlSubstr: input.url_contains || undefined,
        method: input.method || undefined,
        limit: input.limit ?? 50,
      });
      if (rows.length === 0) return textResult('No matching requests.');
      const slim = rows.map((r) => ({
        id: r.id,
        method: r.method,
        url: r.url,
        status: r.status,
        type: r.type,
        source: r.source,
        elapsedMs: r.elapsedMs,
        receivedAt: new Date(r.receivedAt).toISOString(),
      }));
      return textResult(JSON.stringify(slim, null, 2));
    },
  );

  mcp.registerTool(
    'browser_capture_get',
    {
      title: 'Browser capture: full request detail',
      description:
        'Fetch full details for one captured request: headers, request body, response body (when available). Pass the id returned by browser_capture_requests.',
      inputSchema: {
        id: z.string().describe('Request id from browser_capture_requests.'),
        body_max_chars: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Cap for response body excerpt (default 4000).'),
      },
    },
    async (input) => {
      const r = store.getRequest(input.id);
      if (!r) return textResult(`error: no request with id ${input.id}`, true);
      const cap = input.body_max_chars ?? 4000;
      const trimmed = {
        ...r,
        responseBody:
          r.responseBody && r.responseBody.length > cap
            ? `${r.responseBody.slice(0, cap)}...<truncated ${r.responseBody.length - cap} chars>`
            : r.responseBody,
        receivedAt: new Date(r.receivedAt).toISOString(),
      };
      return textResult(JSON.stringify(trimmed, null, 2));
    },
  );

  mcp.registerTool(
    'browser_capture_snapshot',
    {
      title: 'Browser capture: session snapshot',
      description:
        "Return the most recent session snapshot captured by the extension: cookies (incl. HttpOnly), localStorage, sessionStorage, document.cookie, page URL. Use this to construct authenticated requests — copy the relevant cookies into a 'Cookie' header.",
      inputSchema: {
        url_contains: z
          .string()
          .optional()
          .describe('Optional: most recent snapshot whose URL contains this substring.'),
      },
    },
    async (input) => {
      const snap = store.latestSnapshot(input.url_contains || undefined);
      if (!snap) {
        return textResult(
          'No snapshots captured yet. Click "Snapshot tab" in the extension popup.',
        );
      }
      return textResult(
        JSON.stringify({ ...snap, receivedAt: new Date(snap.receivedAt).toISOString() }, null, 2),
      );
    },
  );

  mcp.registerTool(
    'browser_capture_clear',
    {
      title: 'Browser capture: clear store',
      description:
        'Wipe all captured requests, endpoints, and snapshots from the in-memory store. Forwarding continues — new captures will repopulate it.',
      inputSchema: {},
    },
    async () => {
      store.clear();
      return textResult('cleared.');
    },
  );

  // ---- Transport ----

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  // McpServer's connect resolves once the transport is wired; the process
  // is kept alive by the stdio streams. Nothing else to do here.
  return new Promise<number>(() => {
    // Never resolve — process exits via signal handlers above.
  });
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    isError,
  };
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(
      `[pentesterflow-browser-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
