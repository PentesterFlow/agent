// browser_capture_* tools. Surface traffic the PentesterFlow Chrome
// extension forwards to the local ingest server. The agent uses these to
// reason about the target's surface, replay interesting requests, and
// reuse captured session cookies / storage.
//
// All tools are read-only against the local store and run synchronously —
// they don't issue any network I/O themselves, so they don't require
// permission gating. Replay-via-http is intentionally NOT wired here;
// the agent already has the gated `http` tool for that.

import type { CaptureStore } from '../browser/store.js';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argNumber, argString } from './types.js';

const TOOL_PREFIX = 'browser_capture_';

abstract class BaseCaptureTool implements Tool {
  protected readonly store: CaptureStore;

  constructor(store: CaptureStore) {
    this.store = store;
  }

  abstract name(): string;
  abstract description(): string;
  abstract schema(): Record<string, unknown>;
  abstract run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    prompter: Prompter,
  ): Promise<string>;

  requiresPermission(): boolean {
    return false;
  }
}

export class BrowserCaptureStatusTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}status`;
  }
  description(): string {
    return 'Show counts and last-activity time for traffic captured by the PentesterFlow Chrome extension. Call this first to confirm the extension is connected and forwarding before relying on the other browser_capture_* tools.';
  }
  schema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }
  async run(): Promise<string> {
    const s = this.store.status();
    const lastSeen = s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : 'never';
    return JSON.stringify(
      {
        requests: s.requestCount,
        endpoints: s.endpointCount,
        snapshots: s.snapshotCount,
        lastActivityAt: lastSeen,
      },
      null,
      2,
    );
  }
}

export class BrowserCaptureEndpointsTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}endpoints`;
  }
  description(): string {
    return 'List unique endpoints (METHOD + path-without-query) observed by the Chrome extension, with the set of query and body parameter names ever seen for each. Use this to plan IDOR / injection / fuzz targets without re-crawling.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url_contains: {
          type: 'string',
          description: 'Filter to endpoints whose URL contains this substring.',
        },
        method: { type: 'string', description: 'Filter to a single HTTP method (GET, POST, ...).' },
      },
    };
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const eps = this.store.listEndpoints({
      urlSubstr: argString(args, 'url_contains') || undefined,
      method: argString(args, 'method') || undefined,
    });
    if (eps.length === 0)
      return 'No endpoints captured yet. Confirm the extension is running with capture enabled and the scope regex matches the target.';
    return JSON.stringify(eps, null, 2);
  }
}

export class BrowserCaptureRequestsTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}requests`;
  }
  description(): string {
    return 'List recent captured requests (most-recent first), with id, method, url, and status. Use the returned id with browser_capture_get to retrieve full headers + body for a specific request.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url_contains: {
          type: 'string',
          description: 'Filter to requests whose URL contains this substring.',
        },
        method: { type: 'string', description: 'Filter to a single HTTP method.' },
        limit: {
          type: 'number',
          description: 'Maximum number of requests to return (default 50).',
        },
      },
    };
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const limit = argNumber(args, 'limit') ?? 50;
    const rows = this.store.listRequests({
      urlSubstr: argString(args, 'url_contains') || undefined,
      method: argString(args, 'method') || undefined,
      limit,
    });
    if (rows.length === 0) return 'No matching requests.';
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
    return JSON.stringify(slim, null, 2);
  }
}

export class BrowserCaptureGetTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}get`;
  }
  description(): string {
    return 'Fetch full details for one captured request: headers, request body, response body (when available). Pass the id returned by browser_capture_requests.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Request id from browser_capture_requests.' },
        body_max_chars: {
          type: 'number',
          description: 'Optional cap for the response body excerpt (default 4000).',
        },
      },
      required: ['id'],
    };
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const id = argString(args, 'id');
    if (!id) return 'error: id is required';
    const r = this.store.getRequest(id);
    if (!r) return `error: no request with id ${id}`;
    const cap = argNumber(args, 'body_max_chars') ?? 4000;
    const trimmed = {
      ...r,
      responseBody:
        r.responseBody && r.responseBody.length > cap
          ? `${r.responseBody.slice(0, cap)}...<truncated ${r.responseBody.length - cap} chars>`
          : r.responseBody,
      receivedAt: new Date(r.receivedAt).toISOString(),
    };
    return JSON.stringify(trimmed, null, 2);
  }
}

export class BrowserCaptureSnapshotTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}snapshot`;
  }
  description(): string {
    return "Return the most recent session snapshot captured by the extension: cookies (incl. HttpOnly), localStorage, sessionStorage, document.cookie, page URL. Use this to construct authenticated requests via the http tool — copy the relevant cookies into a 'Cookie' header.";
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url_contains: {
          type: 'string',
          description:
            'Optional: return the most recent snapshot whose URL contains this substring.',
        },
      },
    };
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const snap = this.store.latestSnapshot(argString(args, 'url_contains') || undefined);
    if (!snap) return 'No snapshots captured yet. Click "Snapshot tab" in the extension popup.';
    return JSON.stringify(
      { ...snap, receivedAt: new Date(snap.receivedAt).toISOString() },
      null,
      2,
    );
  }
}

export class BrowserCaptureClearTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}clear`;
  }
  description(): string {
    return 'Clear all captured requests, endpoints, and snapshots from the local store. Use this between phases or when scope changes.';
  }
  schema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }
  override requiresPermission(): boolean {
    return true; // destructive against the in-memory capture
  }
  summarize(): { summary: string; detail: string } {
    return {
      summary: 'clear browser capture store',
      detail:
        'Wipes all captured requests, endpoints, and snapshots from memory. Forwarding continues — new captures will repopulate the store.',
    };
  }
  permissionHints(): { noSessionCache: boolean } {
    return { noSessionCache: true };
  }
  async run(): Promise<string> {
    this.store.clear();
    return 'cleared.';
  }
}

export class BrowserCaptureBurpTasksTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}burp_tasks`;
  }
  description(): string {
    return 'List scan / plan / scope tasks queued from the PentesterFlow Burp extension. Use this after the user sends requests from Burp to decide what to scan or plan next.';
  }
  schema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }
  async run(): Promise<string> {
    const tasks = this.store.listBurpTasks();
    if (tasks.length === 0) return 'No Burp tasks queued.';
    return JSON.stringify(
      tasks.map((t) => ({ ...t, createdAt: new Date(t.createdAt).toISOString() })),
      null,
      2,
    );
  }
}

export class BrowserCaptureBurpIssuesTool extends BaseCaptureTool {
  name(): string {
    return `${TOOL_PREFIX}burp_issues`;
  }
  description(): string {
    return 'List PentesterFlow issues exposed to the Burp extension for import into Burp Scanner issues.';
  }
  schema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }
  async run(): Promise<string> {
    const issues = this.store.listBurpIssues();
    if (issues.length === 0) return 'No PentesterFlow issues queued for Burp import.';
    return JSON.stringify(
      issues.map((i) => ({ ...i, createdAt: new Date(i.createdAt).toISOString() })),
      null,
      2,
    );
  }
}

export function registerBrowserCaptureTools(
  register: (t: Tool) => void,
  store: CaptureStore,
): void {
  register(new BrowserCaptureStatusTool(store));
  register(new BrowserCaptureEndpointsTool(store));
  register(new BrowserCaptureRequestsTool(store));
  register(new BrowserCaptureGetTool(store));
  register(new BrowserCaptureSnapshotTool(store));
  register(new BrowserCaptureBurpTasksTool(store));
  register(new BrowserCaptureBurpIssuesTool(store));
  register(new BrowserCaptureClearTool(store));
}
