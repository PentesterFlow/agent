import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGAGEMENT_CHAR_LIMIT, EngagementStore } from './store.js';

describe('EngagementStore', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pf-engage-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'pf-engage-home-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function writeEngagement(root: string, body: string): void {
    const dir = join(root, '.pentesterflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'engagement.md'), body);
  }

  it('returns empty string when no files exist', () => {
    expect(new EngagementStore({ cwd, home }).load()).toBe('');
  });

  it('merges personal then project notes', () => {
    writeEngagement(home, 'Global rule: stay in scope');
    writeEngagement(cwd, 'Target: app.example.com only');
    const out = new EngagementStore({ cwd, home }).load();
    // Personal first, project last (most specific nearest the end).
    expect(out.indexOf('Global rule')).toBeLessThan(out.indexOf('Target: app.example.com'));
  });

  it('loads project notes even when personal is absent', () => {
    writeEngagement(cwd, 'Out of scope: *.corp.internal');
    expect(new EngagementStore({ cwd, home }).load()).toContain('Out of scope: *.corp.internal');
  });

  it('truncates combined notes past the char limit with a marker', () => {
    writeEngagement(cwd, 'x'.repeat(ENGAGEMENT_CHAR_LIMIT + 500));
    const out = new EngagementStore({ cwd, home }).load();
    expect(out.length).toBeLessThan(ENGAGEMENT_CHAR_LIMIT + 200);
    expect(out).toContain('engagement notes truncated');
  });
});
