// In-process store for traffic captured by the Chrome extension companion.
// Holds requests, deduped endpoint map, and the most recent per-tab session
// snapshots (cookies / localStorage / sessionStorage). Bounded by maxEntries
// so a noisy capture session can't OOM the agent.

export interface CapturedHeader {
  name: string;
  value: string;
}

export interface CapturedRequest {
  /** Stable id (extension request id, prefixed with source for uniqueness). */
  id: string;
  source: 'webRequest' | 'fetch' | 'xhr' | 'ws' | 'unknown';
  tabId?: number;
  method: string;
  url: string;
  type?: string;
  initiator?: string;
  status?: number;
  fromCache?: boolean;
  requestHeaders?: CapturedHeader[];
  responseHeaders?: CapturedHeader[];
  requestBody?: unknown;
  responseBody?: string;
  timeStart?: number;
  timeEnd?: number;
  elapsedMs?: number;
  receivedAt: number;
}

export interface EndpointSummary {
  method: string;
  url: string;
  queryParams: string[];
  bodyParams: string[];
  hitCount: number;
  firstSeen: number;
  lastSeen: number;
}

export interface SessionSnapshot {
  receivedAt: number;
  url: string;
  title?: string;
  userAgent?: string;
  documentCookie?: string;
  cookies?: unknown[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface BurpTask {
  id: string;
  action: 'scan' | 'plan' | 'scope';
  target?: string;
  method?: string;
  url?: string;
  host?: string;
  rawRequestB64?: string;
  notes?: string;
  source: 'burp';
  createdAt: number;
}

export interface BurpIssue {
  id: string;
  title: string;
  severity: string;
  confidence?: string;
  url: string;
  method?: string;
  parameter?: string;
  detail: string;
  remediation?: string;
  path?: string;
  rawRequestB64?: string;
  rawResponseB64?: string;
  createdAt: number;
}

interface EndpointRecord {
  method: string;
  url: string;
  queryParams: Set<string>;
  bodyParams: Set<string>;
  hitCount: number;
  firstSeen: number;
  lastSeen: number;
}

export interface CaptureStoreOptions {
  maxEntries?: number;
}
const BODY_STRING_CAP = 64 * 1024;
// Bound the endpoint metadata so a long capture of attacker-influenced traffic
// with unique paths/param names can't grow memory without limit (M9).
const MAX_ENDPOINTS = 2000;
const MAX_PARAMS_PER_ENDPOINT = 256;

export class CaptureStore {
  private readonly requests: Map<string, CapturedRequest> = new Map();
  private readonly endpoints: Map<string, EndpointRecord> = new Map();
  private readonly snapshots: SessionSnapshot[] = [];
  private readonly burpTasks: BurpTask[] = [];
  private readonly burpIssues: BurpIssue[] = [];
  private readonly maxEntries: number;
  private nextSeq = 1;
  private lastActivityAt = 0;

  constructor(opts: CaptureStoreOptions = {}) {
    this.maxEntries = Math.max(100, opts.maxEntries ?? 5000);
  }

  ingest(raw: unknown): { ok: boolean; reason?: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
    const obj = raw as Record<string, unknown>;

    // Page-context events (fetch/XHR/WS) come with `kind`. webRequest
    // events come with `id`/`method`/`url` directly from the background SW.
    const kind = typeof obj.kind === 'string' ? obj.kind : undefined;

    if (kind === 'ws-open' || kind === 'ws-send' || kind === 'ws-recv') {
      this.recordEndpoint('WS', (obj.url as string) || '', undefined, undefined);
      this.lastActivityAt = Date.now();
      return { ok: true };
    }

    const url = typeof obj.url === 'string' ? obj.url : '';
    if (!url) return { ok: false, reason: 'missing url' };

    const method = (typeof obj.method === 'string' ? obj.method : 'GET').toUpperCase();
    const idSeed = obj.id ?? `${kind ?? 'wr'}-${this.nextSeq++}`;
    const id = `${kind ?? 'wr'}:${String(idSeed)}`;

    const entry: CapturedRequest = {
      id,
      source:
        kind === 'fetch' || kind === 'xhr' || kind === 'ws'
          ? (kind as CapturedRequest['source'])
          : kind
            ? 'unknown'
            : 'webRequest',
      tabId: typeof obj.tabId === 'number' ? obj.tabId : undefined,
      method,
      url,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      initiator: typeof obj.initiator === 'string' ? obj.initiator : undefined,
      status: typeof obj.status === 'number' ? obj.status : undefined,
      fromCache: typeof obj.fromCache === 'boolean' ? obj.fromCache : undefined,
      requestHeaders: this.coerceHeaders(obj.requestHeaders ?? obj.reqHeaders),
      responseHeaders: this.coerceHeaders(obj.responseHeaders ?? obj.respHeaders),
      requestBody: capBody(obj.requestBody ?? obj.reqBody ?? undefined),
      responseBody: typeof obj.respBody === 'string' ? capString(obj.respBody) : undefined,
      timeStart: typeof obj.timeStart === 'number' ? obj.timeStart : undefined,
      timeEnd: typeof obj.timeEnd === 'number' ? obj.timeEnd : undefined,
      elapsedMs: typeof obj.elapsedMs === 'number' ? obj.elapsedMs : undefined,
      receivedAt: Date.now(),
    };

    this.requests.set(id, entry);
    this.recordEndpoint(method, url, entry.requestBody, this.queryParams(url));
    this.pruneIfNeeded();
    this.lastActivityAt = Date.now();
    return { ok: true };
  }

  ingestSnapshot(raw: unknown): { ok: boolean; reason?: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
    const obj = raw as Record<string, unknown>;
    if (typeof obj.url !== 'string') return { ok: false, reason: 'missing url' };
    const snap: SessionSnapshot = {
      receivedAt: Date.now(),
      url: obj.url,
      title: typeof obj.title === 'string' ? obj.title : undefined,
      userAgent: typeof obj.userAgent === 'string' ? obj.userAgent : undefined,
      documentCookie:
        typeof obj.documentCookie === 'string' ? capString(obj.documentCookie) : undefined,
      cookies: Array.isArray(obj.cookies) ? obj.cookies : undefined,
      localStorage: this.coerceStringMap(obj.localStorage),
      sessionStorage: this.coerceStringMap(obj.sessionStorage),
    };
    this.snapshots.push(snap);
    if (this.snapshots.length > 100) this.snapshots.splice(0, this.snapshots.length - 100);
    this.lastActivityAt = Date.now();
    return { ok: true };
  }

  status(): {
    requestCount: number;
    endpointCount: number;
    snapshotCount: number;
    lastActivityAt: number;
  } {
    return {
      requestCount: this.requests.size,
      endpointCount: this.endpoints.size,
      snapshotCount: this.snapshots.length,
      lastActivityAt: this.lastActivityAt,
    };
  }

  listRequests(filter?: {
    urlSubstr?: string;
    method?: string;
    limit?: number;
  }): CapturedRequest[] {
    const limit = filter?.limit ?? 200;
    const urlSubstr = filter?.urlSubstr?.toLowerCase();
    const method = filter?.method?.toUpperCase();
    const out: CapturedRequest[] = [];
    // Iterate newest first.
    const all = [...this.requests.values()].reverse();
    for (const r of all) {
      if (urlSubstr && !r.url.toLowerCase().includes(urlSubstr)) continue;
      if (method && r.method !== method) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  getRequest(id: string): CapturedRequest | undefined {
    return this.requests.get(id);
  }

  listEndpoints(filter?: { urlSubstr?: string; method?: string }): EndpointSummary[] {
    const urlSubstr = filter?.urlSubstr?.toLowerCase();
    const method = filter?.method?.toUpperCase();
    return [...this.endpoints.values()]
      .filter((e) => {
        if (urlSubstr && !e.url.toLowerCase().includes(urlSubstr)) return false;
        if (method && e.method !== method) return false;
        return true;
      })
      .map((e) => ({
        method: e.method,
        url: e.url,
        queryParams: [...e.queryParams],
        bodyParams: [...e.bodyParams],
        hitCount: e.hitCount,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      }))
      .sort((a, b) => b.hitCount - a.hitCount);
  }

  latestSnapshot(urlSubstr?: string): SessionSnapshot | undefined {
    if (!urlSubstr) return this.snapshots[this.snapshots.length - 1];
    const needle = urlSubstr.toLowerCase();
    for (let i = this.snapshots.length - 1; i >= 0; i -= 1) {
      const snap = this.snapshots[i];
      if (snap?.url.toLowerCase().includes(needle)) return snap;
    }
    return undefined;
  }

  listSnapshots(): SessionSnapshot[] {
    return [...this.snapshots];
  }

  clear(): void {
    this.requests.clear();
    this.endpoints.clear();
    this.snapshots.length = 0;
    this.burpTasks.length = 0;
    this.burpIssues.length = 0;
  }

  ingestBurpTask(raw: unknown): { ok: boolean; reason?: string; task?: BurpTask } {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
    const obj = raw as Record<string, unknown>;
    const action = obj.action;
    if (action !== 'scan' && action !== 'plan' && action !== 'scope') {
      return { ok: false, reason: 'action must be scan, plan, or scope' };
    }
    const task: BurpTask = {
      id: `burp-task-${this.nextSeq++}`,
      action,
      target: typeof obj.target === 'string' ? obj.target : undefined,
      method: typeof obj.method === 'string' ? obj.method : undefined,
      url: typeof obj.url === 'string' ? obj.url : undefined,
      host: typeof obj.host === 'string' ? obj.host : undefined,
      rawRequestB64: typeof obj.rawRequestB64 === 'string' ? obj.rawRequestB64 : undefined,
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
      source: 'burp',
      createdAt: Date.now(),
    };
    this.burpTasks.push(task);
    if (this.burpTasks.length > 1000) this.burpTasks.splice(0, this.burpTasks.length - 1000);
    this.lastActivityAt = Date.now();
    return { ok: true, task };
  }

  listBurpTasks(): BurpTask[] {
    return [...this.burpTasks].reverse();
  }

  ingestBurpIssue(raw: unknown): { ok: boolean; reason?: string; issue?: BurpIssue } {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title : '';
    const url = typeof obj.url === 'string' ? obj.url : '';
    const detail = typeof obj.detail === 'string' ? obj.detail : '';
    if (!title || !url || !detail) return { ok: false, reason: 'title, url, and detail required' };
    const issue: BurpIssue = {
      id: typeof obj.id === 'string' ? obj.id : `burp-issue-${this.nextSeq++}`,
      title,
      severity: typeof obj.severity === 'string' ? obj.severity : 'Information',
      confidence: typeof obj.confidence === 'string' ? obj.confidence : 'Tentative',
      url,
      method: typeof obj.method === 'string' ? obj.method : undefined,
      parameter: typeof obj.parameter === 'string' ? obj.parameter : undefined,
      detail,
      remediation: typeof obj.remediation === 'string' ? obj.remediation : undefined,
      path: typeof obj.path === 'string' ? obj.path : undefined,
      rawRequestB64: typeof obj.rawRequestB64 === 'string' ? obj.rawRequestB64 : undefined,
      rawResponseB64: typeof obj.rawResponseB64 === 'string' ? obj.rawResponseB64 : undefined,
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
    };
    this.upsertBurpIssue(issue);
    this.lastActivityAt = Date.now();
    return { ok: true, issue };
  }

  addBurpIssue(
    issue: Omit<BurpIssue, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  ): void {
    this.upsertBurpIssue({
      ...issue,
      id: issue.id ?? `pf-finding-${this.nextSeq++}`,
      createdAt: issue.createdAt ?? Date.now(),
    });
    this.lastActivityAt = Date.now();
  }

  listBurpIssues(): BurpIssue[] {
    return [...this.burpIssues].reverse();
  }

  // ---- internals ----

  private upsertBurpIssue(issue: BurpIssue): void {
    const idx = this.burpIssues.findIndex((i) => i.id === issue.id);
    if (idx >= 0) this.burpIssues[idx] = issue;
    else this.burpIssues.push(issue);
    if (this.burpIssues.length > 1000) this.burpIssues.splice(0, this.burpIssues.length - 1000);
  }

  private recordEndpoint(
    method: string,
    url: string,
    body: unknown,
    queryParamsHint?: string[],
  ): void {
    const noQuery = this.urlNoQuery(url);
    const key = `${method} ${noQuery}`;
    let rec = this.endpoints.get(key);
    if (rec) {
      // Re-insert so Map iteration order tracks recency (LRU): delete now,
      // set again below at the most-recent position.
      this.endpoints.delete(key);
    } else {
      rec = {
        method,
        url: noQuery,
        queryParams: new Set(),
        bodyParams: new Set(),
        hitCount: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
    }
    this.endpoints.set(key, rec);
    rec.hitCount += 1;
    rec.lastSeen = Date.now();
    // Cap each param Set so a single endpoint hit with thousands of distinct
    // param names can't grow unbounded.
    const qp = queryParamsHint ?? this.queryParams(url);
    for (const q of qp) {
      if (rec.queryParams.size >= MAX_PARAMS_PER_ENDPOINT) break;
      rec.queryParams.add(q);
    }
    for (const b of this.bodyParamNames(body)) {
      if (rec.bodyParams.size >= MAX_PARAMS_PER_ENDPOINT) break;
      rec.bodyParams.add(b);
    }
    this.pruneEndpointsIfNeeded();
  }

  // Evict least-recently-seen endpoints once over the cap. Map iteration order
  // is recency order (recordEndpoint re-inserts on each hit), so the oldest
  // entries sit at the front.
  private pruneEndpointsIfNeeded(): void {
    if (this.endpoints.size <= MAX_ENDPOINTS) return;
    const drop = this.endpoints.size - MAX_ENDPOINTS;
    let i = 0;
    for (const k of this.endpoints.keys()) {
      if (i++ >= drop) break;
      this.endpoints.delete(k);
    }
  }

  private urlNoQuery(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      const i = url.indexOf('?');
      return i >= 0 ? url.slice(0, i) : url;
    }
  }

  private queryParams(url: string): string[] {
    try {
      const u = new URL(url);
      return [...u.searchParams.keys()];
    } catch {
      return [];
    }
  }

  private bodyParamNames(body: unknown): string[] {
    if (!body) return [];
    if (typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      // Extension format: { type: 'form'|'raw', data: ... }
      if (obj.type === 'form' && obj.data && typeof obj.data === 'object') {
        return Object.keys(obj.data as Record<string, unknown>);
      }
      if (obj.type === 'raw' && typeof obj.data === 'string') {
        return this.parseRawBody(obj.data);
      }
      // Plain object body from page-context fetch/XHR.
      return Object.keys(obj);
    }
    if (typeof body === 'string') return this.parseRawBody(body);
    return [];
  }

  private parseRawBody(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return Object.keys(parsed);
        }
      } catch {
        // fall through to urlencoded
      }
    }
    if (trimmed.includes('=')) {
      try {
        return [...new URLSearchParams(trimmed).keys()];
      } catch {
        return [];
      }
    }
    return [];
  }

  private coerceHeaders(v: unknown): CapturedHeader[] | undefined {
    if (!v) return undefined;
    if (Array.isArray(v)) {
      const out: CapturedHeader[] = [];
      for (const item of v) {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          if (typeof o.name === 'string') {
            out.push({ name: o.name, value: typeof o.value === 'string' ? o.value : '' });
          }
        } else if (Array.isArray(item) && item.length === 2) {
          out.push({ name: String(item[0]), value: String(item[1]) });
        } else if (typeof item === 'string') {
          // "name: value" style
          const i = item.indexOf(':');
          if (i > 0) out.push({ name: item.slice(0, i).trim(), value: item.slice(i + 1).trim() });
        }
      }
      return out;
    }
    if (typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).map(([name, value]) => ({
        name,
        value: typeof value === 'string' ? value : String(value),
      }));
    }
    return undefined;
  }

  private coerceStringMap(v: unknown): Record<string, string> | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = typeof val === 'string' ? val : String(val);
    }
    return out;
  }

  private pruneIfNeeded(): void {
    if (this.requests.size <= this.maxEntries) return;
    const drop = this.requests.size - this.maxEntries;
    let i = 0;
    for (const k of this.requests.keys()) {
      if (i++ >= drop) break;
      this.requests.delete(k);
    }
  }
}

function capBody(value: unknown): unknown {
  if (typeof value === 'string') return capString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(capBody);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capBody(item);
  }
  return out;
}

function capString(value: string): string {
  if (value.length <= BODY_STRING_CAP) return value;
  return `${value.slice(0, BODY_STRING_CAP)}...<truncated ${value.length - BODY_STRING_CAP} chars>`;
}
