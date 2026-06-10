// Round-trip + crash-safety tests for the session store.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Target } from '../target/target.js';
import { Store, cleanupStaleTemps, newID, validateID } from './store.js';

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pf-session-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('session.newID / validateID', () => {
  it('generates RFC-ish UUIDv4-shaped ids', () => {
    const id = newID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('rejects path traversal in ids', () => {
    expect(() => validateID('../etc/passwd')).toThrow();
    expect(() => validateID('a/b')).toThrow();
    expect(() => validateID('')).toThrow();
  });
  it('accepts a normal id', () => {
    expect(() => validateID(newID())).not.toThrow();
  });
});

describe('session.Store', () => {
  it('round-trips messages and target', async () => {
    const id = newID();
    const store = Store.newWithID(tmp, id);
    const target = new Target();
    target.setBaseURL('https://app.example.com');
    await store.save(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      target,
    );
    const loaded = store.load();
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1]?.content).toBe('hi');
    expect(loaded.target?.baseURL()).toBe('https://app.example.com');
  });

  it('persists target as null when empty', async () => {
    const store = Store.newWithID(tmp, newID());
    await store.save([{ role: 'user', content: 'hi' }], new Target());
    const loaded = store.load();
    expect(loaded.target).toBeNull();
  });

  it('round-trips optional session memory', async () => {
    const store = Store.newWithID(tmp, newID());
    await store.save([{ role: 'user', content: 'hi' }], null, {
      version: 1,
      updatedAt: '2026-06-02T00:00:00.000Z',
      compactions: 1,
      lastCompactedAt: '2026-06-02T00:00:00.000Z',
      lastSummary: 'summary',
      objectives: ['test authz'],
      plan: ['enumerate auth endpoints, then test IDOR'],
      completed: ['mapped auth surface'],
      findings: ['idor on /api/orders/1'],
      tested: ['GET /api/orders/:id as user A/B'],
      files: ['findings/idor.md'],
      commands: ['curl https://app.example.com/api/orders/1'],
      credentials: ['USER_A_TOKEN placeholder'],
      todos: ['retest with admin role'],
    });
    const loaded = store.load();
    expect(loaded.memory?.compactions).toBe(1);
    expect(loaded.memory?.findings).toContain('idor on /api/orders/1');
  });

  it('saved file leaves no orphan .tmp', async () => {
    const store = Store.newWithID(tmp, newID());
    await store.save([{ role: 'user', content: 'x' }], null);
    const orphans = readdirSync(tmp).filter((n) => n.includes('.tmp'));
    expect(orphans).toEqual([]);
  });

  it('saved file has 0o600 perms', async () => {
    const store = Store.newWithID(tmp, newID());
    await store.save([{ role: 'user', content: 'x' }], null);
    const { statSync } = await import('node:fs');
    const mode = statSync(store.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes context snapshots under the pentesterflow context directory', async () => {
    const store = Store.newWithID(join(tmp, 'sessions'), 'abc123');
    const outPath = await store.saveContextSnapshot('# Context\n\nredacted history');
    expect(outPath).toBe(join(tmp, 'context', 'abc123.md'));
    expect(readFileSync(outPath, 'utf8')).toContain('redacted history');
    const { statSync } = await import('node:fs');
    const mode = statSync(outPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('session.cleanupStaleTemps', () => {
  it('removes old .tmp files but keeps fresh ones', () => {
    const stale = join(tmp, 'a.json.tmp.deadbeef');
    const fresh = join(tmp, 'b.json.tmp.cafebabe');
    writeFileSync(stale, 'old');
    writeFileSync(fresh, 'new');
    // Backdate the stale file by 5 minutes.
    const { utimesSync } = require('node:fs');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(stale, old, old);

    cleanupStaleTemps(tmp, 60_000);
    const remaining = readdirSync(tmp);
    expect(remaining).toContain('b.json.tmp.cafebabe');
    expect(remaining).not.toContain('a.json.tmp.deadbeef');
  });
});
