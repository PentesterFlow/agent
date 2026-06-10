// Session persistence at ~/.pentesterflow/sessions/<uuid>.json. The JSON
// schema is kept stable so saved sessions remain loadable across
// versions.
//
// Crash-safe save: write to unique sibling .tmp.<id>, fsync, rename onto
// the real path. cleanupStaleTemps() sweeps orphaned temps from a previous
// crash at startup (older than 1 minute).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Target } from '../target/target.js';

// ---------- Shared message shape ----------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallID?: string;
  name?: string;
}

export interface SessionFile {
  updated_at: string;
  id?: string;
  target?: ReturnType<Target['toJSON']> | null;
  memory?: SessionMemory | null;
  messages: Message[];
}

export interface SessionMemory {
  version: 1;
  updatedAt: string;
  compactions: number;
  lastCompactedAt?: string;
  lastSummary?: string;
  objectives: string[];
  plan: string[];
  completed: string[];
  findings: string[];
  tested: string[];
  files: string[];
  commands: string[];
  credentials: string[];
  todos: string[];
}

// ---------- IDs ----------

export function newID(): string {
  const b = randomBytes(16);
  // Stamp version (4) + variant (10).
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function validateID(id: string): void {
  if (!id) throw new Error('session id is required');
  if (/[/\\]/.test(id) || id.includes('..')) {
    throw new Error(`invalid session id: ${id}`);
  }
}

export function dirFromPath(path: string): string {
  if (!path) return join(homedir(), '.pentesterflow', 'sessions');
  return dirname(path);
}

// ---------- Store ----------

export class Store {
  readonly path: string;
  readonly id: string;

  constructor(path: string, id = '') {
    this.path = path;
    this.id = id;
  }

  static newWithID(dir: string, id: string): Store {
    return new Store(join(dir, `${id}.json`), id);
  }

  contextSnapshotPath(): string {
    const id = this.id || basename(this.path).replace(/\.json$/, '') || 'session';
    return join(dirname(dirname(this.path)), 'context', `${id}.md`);
  }

  load(): { messages: Message[]; target: Target | null; memory: SessionMemory | null } {
    if (!this.path || !existsSync(this.path)) {
      return { messages: [], target: null, memory: null };
    }
    const buf = readFileSync(this.path, 'utf8');
    const raw = JSON.parse(buf) as Partial<SessionFile>;
    const target = raw.target ? Target.fromJSON(raw.target) : null;
    return { messages: raw.messages ?? [], target, memory: raw.memory ?? null };
  }

  async save(
    messages: Message[],
    target: Target | null,
    memory?: SessionMemory | null,
  ): Promise<void> {
    if (!this.path) return;
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const persistedTarget = target && !target.empty() ? target.toJSON() : null;
    const file: SessionFile = {
      updated_at: new Date().toISOString(),
      id: this.id || undefined,
      target: persistedTarget,
      memory: memory ?? undefined,
      messages,
    };
    const body = `${JSON.stringify(file, null, 2)}\n`;

    const tmp = `${this.path}.tmp.${randomBytes(3).toString('hex')}`;
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(tmp, 'wx', 0o600);
      await fh.writeFile(body);
      await fh.sync();
      await fh.close();
      fh = undefined;
      await rename(tmp, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    } catch (err) {
      if (fh) {
        try {
          await fh.close();
        } catch {
          /* ignore */
        }
      }
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async clear(): Promise<void> {
    if (!this.path) return;
    try {
      await unlink(this.path);
    } catch (err: unknown) {
      // ENOENT is fine — nothing to clear.
      if (!(err instanceof Error) || !err.message.includes('ENOENT')) throw err;
    }
  }

  async saveContextSnapshot(markdown: string): Promise<string> {
    if (!this.path) return '';
    const outPath = this.contextSnapshotPath();
    const dir = dirname(outPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
    const tmp = `${outPath}.tmp.${randomBytes(3).toString('hex')}`;
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(tmp, 'wx', 0o600);
      await fh.writeFile(body);
      await fh.sync();
      await fh.close();
      fh = undefined;
      await rename(tmp, outPath);
      await chmod(outPath, 0o600).catch(() => undefined);
      return outPath;
    } catch (err) {
      if (fh) {
        try {
          await fh.close();
        } catch {
          /* ignore */
        }
      }
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

// ---------- Maintenance ----------

/**
 * Remove orphaned `.tmp.*` files in `dir` older than `maxAgeMs`. Best-
 * effort; errors are swallowed.
 */
export function cleanupStaleTemps(dir: string, maxAgeMs: number): void {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeMs;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.includes('.tmp.') && !name.endsWith('.tmp')) continue;
    const full = join(dir, name);
    try {
      const info = statSync(full);
      if (info.mtimeMs > cutoff) continue;
      // Synchronous so the sweep completes before the rest of startup
      // (and the test that checks the directory contents) observes it.
      // Best-effort; ignore individual failures.
      try {
        unlinkSync(full);
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }
}

// ---------- Listing ----------

export interface Summary {
  id: string;
  path: string;
  updatedAt: Date;
  preview: string;
}

/** List `*.json` sessions in `dir`, newest first. Corrupt files skipped. */
export function listDir(dir: string): Summary[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Summary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    let buf: string;
    try {
      buf = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    let raw: Partial<SessionFile>;
    try {
      raw = JSON.parse(buf) as Partial<SessionFile>;
    } catch {
      continue;
    }
    const id = raw.id ?? name.replace(/\.json$/, '');
    const updatedAt = raw.updated_at ? new Date(raw.updated_at) : new Date(0);
    out.push({
      id,
      path: full,
      updatedAt,
      preview: firstUserPreview(raw.messages ?? [], 80),
    });
  }
  return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

function firstUserPreview(messages: Message[], max: number): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    let s = m.content;
    const idx = s.indexOf('\n\n# Referenced files\n\n');
    if (idx >= 0) s = s.slice(0, idx);
    s = s.split('\n', 1)[0]?.trim() ?? '';
    if ([...s].length > max) {
      return `${[...s].slice(0, max - 1).join('')}…`;
    }
    return s;
  }
  return '(no user messages)';
}
