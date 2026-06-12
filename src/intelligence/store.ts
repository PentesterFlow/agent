import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { apply as redact } from '../redact/index.js';

export type IntelligenceScope = 'project' | 'personal' | 'builtin';

// Upper bound on persisted scenarios per scope file, so the JSONL knowledge
// base can't grow without limit across many sessions (M13).
const MAX_SCENARIOS_PER_FILE = 5000;

// Recency boost: at equal token overlap a fresher scenario outranks a stale one
// by up to RECENCY_BOOST (decaying with age), so recent lessons surface first.
const RECENCY_BOOST = 0.25;
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export interface IntelligenceScenario {
  id: string;
  title: string;
  category: string;
  triggers: string[];
  technologies: string[];
  lesson: string;
  recommendedChecks: string[];
  avoidMissing: string[];
  source: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt?: string;
  confidence: number;
  scope: IntelligenceScope;
}

export interface SearchResult {
  scenario: IntelligenceScenario;
  score: number;
  matched: string[];
}

export interface StoreOptions {
  cwd?: string;
  home?: string;
}

const BUILTIN_SCENARIOS: IntelligenceScenario[] = [
  {
    id: 'builtin-node-pm2-source-exposure',
    title: 'Node source exposure should check PM2 deployment files',
    category: 'recon-gap',
    triggers: [
      'server.js',
      'package.json',
      'node',
      'express',
      'source leak',
      'deployment',
      'nginx',
    ],
    technologies: ['Node.js', 'Express', 'PM2'],
    lesson:
      'When Node source files or package metadata are exposed or suspected, deployment/process-manager files may expose environment names, startup commands, paths, and secrets.',
    recommendedChecks: [
      'ecosystem.config.js',
      'ecosystem.config.cjs',
      'ecosystem.config.mjs',
      'pm2.json',
      'process.json',
      'app.js',
      'index.js',
      'server.js~',
      'package-lock.json',
      'backup/archive variants',
    ],
    avoidMissing: ['PM2 ecosystem files', 'process manager JSON files', 'Node backup files'],
    source: 'builtin seed from missed efham.ai scan',
    sourceSessionId: 'c7e9e2a4-085b-43fe-af39-c016341a2f61',
    createdAt: '2026-06-03T00:00:00.000Z',
    confidence: 0.95,
    scope: 'builtin',
  },
];

export class IntelligenceStore {
  readonly projectPath: string;
  readonly personalPath: string;
  // Per-file parsed-scenario cache keyed on {mtimeMs, size}. search()/list() run
  // on the hot path (every turn) and learnFromText re-reads each scope per
  // candidate; caching collapses repeated reads to a single parse until the file
  // changes. This process's own writes invalidate explicitly.
  private readonly fileCache = new Map<
    string,
    { mtimeMs: number; size: number; scenarios: IntelligenceScenario[] }
  >();

  constructor(opts: StoreOptions = {}) {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const home = opts.home ?? homedir();
    this.projectPath = join(cwd, '.pentesterflow', 'intelligence', 'scenarios.jsonl');
    this.personalPath = join(home, '.pentesterflow', 'intelligence', 'scenarios.jsonl');
  }

  list(): IntelligenceScenario[] {
    return dedupeScenarios([
      ...this.readScenarios(this.projectPath, 'project'),
      ...this.readScenarios(this.personalPath, 'personal'),
      ...BUILTIN_SCENARIOS,
    ]);
  }

  // Cached read of a scope file. Invalidated when the file's mtime or size
  // changes, and explicitly by this store's own writes.
  private readScenarios(path: string, scope: IntelligenceScope): IntelligenceScenario[] {
    if (!existsSync(path)) return [];
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(path);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return [];
    }
    const cached = this.fileCache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.scenarios;
    const scenarios = readJSONL(path, scope);
    this.fileCache.set(path, { ...st, scenarios });
    return scenarios;
  }

  private invalidate(path: string): void {
    this.fileCache.delete(path);
  }

  search(query: string, limit = 5): SearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scenarios = this.list();
    // Reference point for the recency boost: the freshest scenario, keeping the
    // ranking deterministic regardless of wall-clock time.
    let refMs = 0;
    for (const s of scenarios) {
      const t = scenarioTimeMs(s);
      if (t > refMs) refMs = t;
    }
    const results: SearchResult[] = [];
    for (const scenario of scenarios) {
      const { score, matched } = scoreScenario(scenario, tokens);
      if (score <= 0) continue;
      results.push({
        scenario,
        score: score * recencyMultiplier(scenarioTimeMs(scenario), refMs),
        matched,
      });
    }
    return results
      .sort((a, b) => b.score - a.score || b.scenario.confidence - a.scenario.confidence)
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  async append(
    input: Omit<IntelligenceScenario, 'id' | 'createdAt' | 'scope'> & {
      id?: string;
      createdAt?: string;
      scope?: Exclude<IntelligenceScope, 'builtin'>;
    },
  ): Promise<IntelligenceScenario | null> {
    const scope = input.scope ?? 'project';
    const saved = await this.appendBatch([input], scope);
    return saved[0] ?? null;
  }

  /**
   * Serialize a check-then-append for a whole batch into one scope file: read
   * the file once, dedupe candidates against an in-memory set (existing rows +
   * earlier candidates in this batch), append all fresh rows in a single write,
   * and prune once at the end. Replaces the per-candidate read/append/prune
   * fan-out so a learnFromText batch touches each file just once.
   */
  private appendBatch(
    candidates: ScenarioInput[],
    scope: Exclude<IntelligenceScope, 'builtin'>,
  ): Promise<IntelligenceScenario[]> {
    return this.serializeWrite(async () => {
      const path = scope === 'personal' ? this.personalPath : this.projectPath;
      const seenIds = new Set<string>();
      const seenKeys = new Set<string>();
      for (const existing of this.readScenarios(path, scope)) {
        seenIds.add(existing.id);
        seenKeys.add(duplicateKey(existing.title, existing.category));
      }
      const fresh: IntelligenceScenario[] = [];
      for (const candidate of candidates) {
        const scenario = normalizeScenario({
          ...candidate,
          id: candidate.id ?? newScenarioID(),
          createdAt: candidate.createdAt ?? new Date().toISOString(),
          scope,
        });
        const key = duplicateKey(scenario.title, scenario.category);
        if (seenIds.has(scenario.id) || seenKeys.has(key)) continue;
        seenIds.add(scenario.id);
        seenKeys.add(key);
        fresh.push(scenario);
      }
      if (fresh.length === 0) return [];
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, fresh.map((s) => `${JSON.stringify(s)}\n`).join(''), { mode: 0o600 });
      await chmod(path, 0o600).catch(() => undefined);
      this.invalidate(path);
      this.pruneIfTooLong(path, scope);
      return fresh;
    });
  }

  // In-process append lock: chains writes so each runs its duplicate check and
  // append atomically with respect to the others. Failures don't break the
  // chain. Both scopes share one chain — appends are infrequent (background
  // learning), so the serialization cost is negligible.
  private writeChain: Promise<unknown> = Promise.resolve();
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Cap the JSONL so a long-lived knowledge base doesn't grow without bound
  // (M13). Keeps the most recent scenarios; older ones age out.
  private pruneIfTooLong(path: string, scope: IntelligenceScope): void {
    try {
      const scenarios = this.readScenarios(path, scope);
      if (scenarios.length <= MAX_SCENARIOS_PER_FILE) return;
      const kept = scenarios.slice(scenarios.length - MAX_SCENARIOS_PER_FILE);
      const body = `${kept.map((s) => JSON.stringify(s)).join('\n')}\n`;
      // Atomic rewrite: tmp + rename so a crash mid-prune can't truncate the
      // knowledge base.
      const tmp = `${path}.tmp.${randomBytes(3).toString('hex')}`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, path);
      this.invalidate(path);
    } catch {
      // Best effort — a prune failure must not break learning.
    }
  }

  /**
   * Clear learned intelligence (the background scenarios.jsonl files).
   * This addresses the historical unbounded growth concern (M13 in AUDIT.md)
   * beyond the automatic pruneIfTooLong (capped at 5000 most-recent).
   * Safe to call; best-effort on errors.
   */
  async clear(scope: 'project' | 'personal' | 'all' = 'all'): Promise<void> {
    const targets: ('project' | 'personal')[] = scope === 'all' ? ['project', 'personal'] : [scope];
    for (const t of targets) {
      const p = t === 'project' ? this.projectPath : this.personalPath;
      try {
        if (existsSync(p)) {
          writeFileSync(p, '', { mode: 0o600 });
        }
        this.invalidate(p);
      } catch {
        // best effort
      }
    }
  }

  /** Return approximate counts for the two scopes (useful for /memory style UX). */
  getStats(): { project: number; personal: number } {
    const proj = this.readScenarios(this.projectPath, 'project').length;
    const pers = this.readScenarios(this.personalPath, 'personal').length;
    return { project: proj, personal: pers };
  }

  async learnFromText(text: string, sourceSessionId?: string): Promise<IntelligenceScenario[]> {
    const cleaned = redact(text);
    const candidates = extractScenarios(cleaned, sourceSessionId);
    if (candidates.length === 0) return [];
    // One batched read/append/prune per scope instead of two per candidate.
    const project = await this.appendBatch(candidates, 'project');
    const personal = await this.appendBatch(candidates, 'personal');
    return [...project, ...personal];
  }
}

export function formatIntelligenceContext(results: SearchResult[]): string {
  if (results.length === 0) return '';
  const out: string[] = [];
  out.push('# Local PentesterFlow Intelligence');
  out.push('');
  out.push(
    'The following local intelligence scenarios matched this turn. Use them as scan-coverage guidance only; verify all claims with live evidence before reporting findings.',
  );
  for (const r of results.slice(0, 5)) {
    const s = r.scenario;
    out.push('');
    out.push(`## ${s.title}`);
    out.push(`Category: ${s.category} · Confidence: ${s.confidence}`);
    out.push(`Matched: ${r.matched.slice(0, 8).join(', ') || 'context'}`);
    out.push(`Lesson: ${s.lesson}`);
    if (s.recommendedChecks.length > 0) {
      out.push(`Recommended checks: ${s.recommendedChecks.slice(0, 12).join(', ')}`);
    }
    if (s.avoidMissing.length > 0) {
      out.push(`Avoid missing: ${s.avoidMissing.slice(0, 8).join(', ')}`);
    }
  }
  return out.join('\n');
}

type ScenarioInput = Parameters<IntelligenceStore['append']>[0];

function extractScenarios(text: string, sourceSessionId?: string): ScenarioInput[] {
  const out: ScenarioInput[] = [];
  const technologies = detectTechnologies(text);
  const contextTriggers = extractTriggers(text).slice(0, 20);
  const lower = text.toLowerCase();

  if (
    (lower.includes('server.js') || lower.includes('package.json')) &&
    (lower.includes('node') || lower.includes('express') || lower.includes('source'))
  ) {
    out.push({
      id: 'learned-node-pm2-source-exposure',
      title: 'Node source exposure should check PM2 deployment files',
      category: 'recon-gap',
      triggers: [
        'server.js',
        'package.json',
        'node',
        'express',
        'source leak',
        'deployment',
        'nginx',
      ],
      technologies: ['Node.js', 'Express', 'PM2'],
      lesson:
        'When Node source files or package metadata appear during recon, include PM2 and process-manager deployment files in the next enumeration pass.',
      recommendedChecks: [
        'ecosystem.config.js',
        'ecosystem.config.cjs',
        'ecosystem.config.mjs',
        'pm2.json',
        'process.json',
        'app.js',
        'index.js',
        'server.js~',
        'package-lock.json',
      ],
      avoidMissing: ['ecosystem.config.js', 'PM2 deployment files'],
      source: 'automatic compaction learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.9,
      scope: 'project',
    });
  }

  const sections = splitMarkdownSections(text);
  const preferenceItems = [
    ...sectionItems(sections, [
      'user preferences and working style',
      'user preferences',
      'working style',
    ]),
    ...explicitPreferenceItems(text),
  ];
  for (const item of preferenceItems.slice(0, 12)) {
    const title = titleFromItem('User preference', item);
    out.push({
      id: stableScenarioID('user-preference', title),
      title,
      category: 'user-preference',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `Adapt future responses and workflows to this user preference: ${trimSentence(item, 500)}`,
      recommendedChecks: [
        'apply this preference when relevant before choosing response style or workflow',
      ],
      avoidMissing: [trimSentence(item, 160)],
      source: 'continuous learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.82,
      scope: 'project',
    });
  }

  for (const item of sectionItems(sections, [
    'decisions and assumptions',
    'important decisions',
  ]).slice(0, 10)) {
    const title = titleFromItem('Decision memory', item);
    out.push({
      id: stableScenarioID('decision', title),
      title,
      category: 'decision',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `Carry this prior decision forward when the same project or pattern recurs: ${trimSentence(item, 500)}`,
      recommendedChecks: ['reuse this decision unless new evidence invalidates it'],
      avoidMissing: [trimSentence(item, 160)],
      source: 'continuous learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.74,
      scope: 'project',
    });
  }

  for (const item of sectionItems(sections, [
    'what worked well',
    'successful solutions',
    'proven workflows',
    'workflow optimization',
    'task outcome',
  ])
    .filter(isWorkflowLikeItem)
    .slice(0, 10)) {
    const title = titleFromItem('Proven workflow', item);
    out.push({
      id: stableScenarioID('proven-workflow', title),
      title,
      category: 'proven-workflow',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `This approach has worked before and should be considered again in similar tasks: ${trimSentence(item, 500)}`,
      recommendedChecks: recommendedChecksFromItem(item),
      avoidMissing: ['reuse proven workflow when context matches'],
      source: 'continuous learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.76,
      scope: 'project',
    });
  }

  for (const item of [
    ...sectionItems(sections, ['what failed and why', 'past mistakes', 'lessons learned']),
    ...bulletItems(text).filter(isFailureLikeItem),
  ].slice(0, 12)) {
    const title = titleFromItem('Lesson learned', item);
    out.push({
      id: stableScenarioID('lesson-learned', title),
      title,
      category: 'lesson-learned',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `Avoid repeating this mistake or failed path: ${trimSentence(item, 500)}`,
      recommendedChecks: ['choose a better strategy before repeating this action'],
      avoidMissing: [trimSentence(item, 160)],
      source: 'continuous learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.8,
      scope: 'project',
    });
  }

  for (const item of sectionItems(sections, [
    'frequently used tools commands and configurations',
    'frequently used tools',
    'files and commands',
    'tools and commands',
  ])
    .filter(isToolConfigLikeItem)
    .slice(0, 12)) {
    const title = titleFromItem('Tool/config memory', item);
    out.push({
      id: stableScenarioID('tool-config', title),
      title,
      category: 'tool-config',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `Remember this useful tool, command, or configuration pattern: ${trimSentence(item, 500)}`,
      recommendedChecks: recommendedChecksFromItem(item),
      avoidMissing: ['reuse known working tool/config pattern when applicable'],
      source: 'continuous learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.73,
      scope: 'project',
    });
  }

  for (const item of [
    ...sectionItems(sections, ['open todos']),
    ...sectionItems(sections, ['next best actions']),
  ].slice(0, 10)) {
    const title = titleFromItem('Next scan step', item);
    out.push({
      id: stableScenarioID('next-step', title),
      title,
      category: 'next-step',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `In similar scan context, include this follow-up: ${trimSentence(item, 500)}`,
      recommendedChecks: recommendedChecksFromItem(item),
      avoidMissing: [trimSentence(item, 160)],
      source: 'automatic compaction learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.72,
      scope: 'project',
    });
  }

  for (const item of sectionItems(sections, ['findings and evidence', 'confirmed findings']).slice(
    0,
    10,
  )) {
    const title = titleFromItem('Finding validation pattern', item);
    out.push({
      id: stableScenarioID('finding-pattern', title),
      title,
      category: 'finding-pattern',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `When this behavior appears, validate it with reproducible evidence before reporting: ${trimSentence(item, 500)}`,
      recommendedChecks: recommendedChecksFromItem(item),
      avoidMissing: ['evidence-backed validation', 'copy-pasteable reproduction request'],
      source: 'automatic compaction learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.78,
      scope: 'project',
    });
  }

  for (const item of sectionItems(sections, ['tested surface', 'decisions and assumptions']).filter(
    isGapLikeItem,
  )) {
    const title = titleFromItem('Coverage gap', item);
    out.push({
      id: stableScenarioID('coverage-gap', title),
      title,
      category: 'coverage-gap',
      triggers: mergeStrings(contextTriggers, extractTriggers(item)),
      technologies,
      lesson: `Do not treat this as complete coverage in future scans without a follow-up check: ${trimSentence(item, 500)}`,
      recommendedChecks: recommendedChecksFromItem(item),
      avoidMissing: [trimSentence(item, 160)],
      source: 'automatic compaction learning',
      sourceSessionId,
      updatedAt: new Date().toISOString(),
      confidence: 0.7,
      scope: 'project',
    });
  }

  return dedupeScenarioInputs(out).slice(0, 25);
}

function splitMarkdownSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = 'summary';
  sections.set(current, []);
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      current = normalizeHeading(heading[1] ?? '');
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

function sectionItems(sections: Map<string, string[]>, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const lines = sections.get(normalizeHeading(name)) ?? [];
    out.push(...bulletItems(lines.join('\n')));
  }
  return out.filter((s) => s.length >= 12).slice(0, 40);
}

function bulletItems(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bullet = trimmed
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trim();
    if (bullet && !/^[-|:]+$/.test(bullet)) out.push(bullet);
  }
  return out;
}

function explicitPreferenceItems(text: string): string[] {
  return bulletItems(text).filter((item) =>
    /\b(?:i prefer|prefer to|always use|always keep|do not|don't|dont|avoid|keep responses|without commands|no commands|use .* instead of)\b/i.test(
      item,
    ),
  );
}

function detectTechnologies(text: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\bnode(?:\.js)?\b/i, 'Node.js'],
    [/\bexpress\b/i, 'Express'],
    [/\bpm2\b|ecosystem\.config/i, 'PM2'],
    [/\bnginx\b/i, 'nginx'],
    [/\bpostgres(?:ql)?\b|\bpg\b/i, 'PostgreSQL'],
    [/\bgraphql\b/i, 'GraphQL'],
    [/\bwordpress\b|\bwp-admin\b/i, 'WordPress'],
    [/\bsupabase\b/i, 'Supabase'],
    [/\baws\b|\bs3\b|\bcognito\b/i, 'AWS'],
  ];
  return checks.filter(([re]) => re.test(text)).map(([, name]) => name);
}

function extractTriggers(text: string): string[] {
  const raw = [
    ...(text.match(/[a-z0-9_.-]+\.(?:js|json|env|yml|yaml|php|py|rb|go|ts|tsx|jsx|html)/gi) ?? []),
    ...(text.match(/\/[a-z0-9_./?=&%-]{2,}/gi) ?? []),
    ...(text.match(
      /\b(?:idor|ssrf|xss|sqli|csrf|cors|rate-limit|source leak|admin|token|jwt|graphql|supabase|pm2|nginx|postgres|express|node)\b/gi,
    ) ?? []),
  ];
  return mergeStrings([], raw).slice(0, 30);
}

function recommendedChecksFromItem(item: string): string[] {
  const checks = extractTriggers(item);
  return checks.length > 0 ? checks : [trimSentence(item, 160)];
}

function isWorkflowLikeItem(item: string): boolean {
  return /\b(?:worked|successful|proven|use|run|command|workflow|approach|strategy|implemented|fixed|verified|passed)\b/i.test(
    item,
  );
}

function isFailureLikeItem(item: string): boolean {
  return /\b(?:failed|failure|mistake|wrong|avoid repeating|did not work|doesn't work|blocked|error|regression|hallucination|missed)\b/i.test(
    item,
  );
}

function isToolConfigLikeItem(item: string): boolean {
  return /`[^`]+`|\b(?:curl|npm|git|rg|python|node|tsx|vitest|biome|tsc|ffuf|nuclei|sqlmap|burp|grep|jq|awk|sed)\b|(?:^|\s)--[a-z0-9-]+/i.test(
    item,
  );
}

function isGapLikeItem(item: string): boolean {
  return /\b(?:not tested|needs?|todo|check|verify|retest|miss(?:ed|ing)|failed|blocked|403|404|unknown|inaccessible|fallback)\b/i.test(
    item,
  );
}

function titleFromItem(prefix: string, item: string): string {
  const clean = trimSentence(item, 90);
  return `${prefix}: ${clean}`;
}

function trimSentence(text: string, max: number): string {
  const compact = text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function mergeStrings(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...a, ...b]) {
    const s = value.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 40);
}

function dedupeScenarioInputs(items: ScenarioInput[]): ScenarioInput[] {
  const seen = new Set<string>();
  const out: ScenarioInput[] = [];
  for (const item of items) {
    const key = `${normalizeKey(item.category)}\n${normalizeKey(item.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function stableScenarioID(category: string, title: string): string {
  let hash = 2166136261;
  for (const ch of `${category}:${title}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `learned-${category}-${(hash >>> 0).toString(16)}`;
}

function normalizeHeading(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function readJSONL(path: string, fallbackScope: IntelligenceScope): IntelligenceScenario[] {
  if (!existsSync(path)) return [];
  let buf = '';
  try {
    buf = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: IntelligenceScenario[] = [];
  for (const line of buf.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(normalizeScenario({ ...JSON.parse(trimmed), scope: fallbackScope }));
    } catch {
      /* skip corrupt lines */
    }
  }
  return out;
}

function normalizeScenario(raw: Partial<IntelligenceScenario>): IntelligenceScenario {
  return {
    id: safeString(raw.id) || newScenarioID(),
    title: redact(safeString(raw.title)).slice(0, 160) || 'Untitled intelligence scenario',
    category: redact(safeString(raw.category)).slice(0, 80) || 'general',
    triggers: normalizeList(raw.triggers),
    technologies: normalizeList(raw.technologies),
    lesson: redact(safeString(raw.lesson)).slice(0, 1200),
    recommendedChecks: normalizeList(raw.recommendedChecks),
    avoidMissing: normalizeList(raw.avoidMissing),
    source: redact(safeString(raw.source)).slice(0, 200) || 'local',
    sourceSessionId: safeString(raw.sourceSessionId).slice(0, 120) || undefined,
    createdAt: safeString(raw.createdAt) || new Date().toISOString(),
    updatedAt: safeString(raw.updatedAt) || undefined,
    confidence: clampConfidence(raw.confidence),
    scope: raw.scope === 'personal' || raw.scope === 'builtin' ? raw.scope : 'project',
  };
}

function normalizeList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const s = redact(safeString(item)).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.slice(0, 160));
  }
  return out.slice(0, 40);
}

function scoreScenario(
  s: IntelligenceScenario,
  queryTokens: string[],
): { score: number; matched: string[] } {
  // Lowercase each field's text once per scenario (not once per query token):
  // search() calls this for every scenario every turn, and the inner loop ran
  // text.toLowerCase() for every (field × token) pair before.
  const fields: Array<[string, number, string]> = [
    [s.title.toLowerCase(), 7, 'title'],
    [s.category.toLowerCase(), 5, 'category'],
    [s.triggers.join(' ').toLowerCase(), 8, 'triggers'],
    [s.technologies.join(' ').toLowerCase(), 6, 'technology'],
    [s.recommendedChecks.join(' ').toLowerCase(), 5, 'recommendedChecks'],
    [s.avoidMissing.join(' ').toLowerCase(), 4, 'avoidMissing'],
    [s.lesson.toLowerCase(), 2, 'lesson'],
  ];
  let score = 0;
  const matched = new Set<string>();
  for (const token of queryTokens) {
    for (const [lowerText, weight, label] of fields) {
      if (!tokenMatchesLower(lowerText, token)) continue;
      score += weight;
      matched.add(`${label}:${token}`);
    }
  }
  if (score > 0) score += s.confidence;
  return { score, matched: [...matched] };
}

// `lowerText` is already lowercased; `token` comes from tokenize() lowercased.
function tokenMatchesLower(lowerText: string, token: string): boolean {
  if (lowerText.includes(token)) return true;
  return token.includes('.') && lowerText.includes(token.replace(/\./g, ' '));
}

function duplicateKey(title: string, category: string): string {
  return `${normalizeKey(category)}\n${normalizeKey(title)}`;
}

function scenarioTimeMs(s: IntelligenceScenario): number {
  const t = Date.parse(s.updatedAt ?? s.createdAt ?? '');
  return Number.isFinite(t) ? t : 0;
}

/** 1 → 1+RECENCY_BOOST as a scenario approaches `refMs`, decaying with age. */
function recencyMultiplier(timeMs: number, refMs: number): number {
  if (timeMs <= 0 || refMs <= 0) return 1;
  const age = Math.max(0, refMs - timeMs);
  return 1 + RECENCY_BOOST * 2 ** (-age / RECENCY_HALF_LIFE_MS);
}

function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []) {
    const token = raw.replace(/^[-_.]+|[-_.]+$/g, '');
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.slice(0, 300);
}

function dedupeScenarios(items: IntelligenceScenario[]): IntelligenceScenario[] {
  const seen = new Set<string>();
  const out: IntelligenceScenario[] = [];
  for (const item of items) {
    const key = `${normalizeKey(item.category)}\n${normalizeKey(item.title)}`;
    if (seen.has(item.id) || seen.has(key)) continue;
    seen.add(item.id);
    seen.add(key);
    out.push(item);
  }
  return out;
}

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/\bnext scan step:\s*\d+\.\s*/g, 'next scan step: ')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampConfidence(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.7;
  return Math.max(0, Math.min(1, n));
}

function newScenarioID(): string {
  return `scn_${randomBytes(8).toString('hex')}`;
}
