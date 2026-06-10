import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Finding, Store } from './store.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pf-findings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Findings Store', () => {
  it('does not overwrite existing findings with the same slug', async () => {
    const store = new Store(dir);
    const finding: Finding = {
      title: 'IDOR',
      severity: 'high',
      url: 'https://app.example.com/api/orders/1',
      impact: 'Cross-account read.',
      createdAt: '2026-06-06T00:00:00.000Z',
      slug: 'idor',
    };

    const first = await store.save(finding);
    const second = await store.save({ ...finding, url: 'https://app.example.com/api/orders/2' });

    expect(first).toBe(join(dir, 'idor.md'));
    expect(second).toBe(join(dir, 'idor-2.md'));
  });
});
