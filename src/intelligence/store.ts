import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { apply as redact } from '../redact/index.js';

export type IntelligenceScope = 'project' | 'personal' | 'builtin';

// Upper bound on persisted scenarios per scope file, so the JSONL knowledge
// base can't grow without limit across many sessions (M13).
const MAX_SCENARIOS_PER_FILE = 5000;

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

  constructor(opts: StoreOptions = {}) {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const home = opts.home ?? homedir();
    this.projectPath = join(cwd, '.pentesterflow', 'intelligence', 'scenarios.jsonl');
    this.personalPath = join(home, '.pentesterflow', 'intelligence', 'scenarios.jsonl');
  }

  list(): IntelligenceScenario[] {
    return dedupeScenarios([
      ...readJSONL(this.projectPath, 'project'),
      ...readJSONL(this.personalPath, 'personal'),
      ...BUILTIN_SCENARIOS,
    ]);
  }

  search(query: string, limit = 5): SearchResult[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const results: SearchResult[] = [];
    for (const scenario of this.list()) {
      const { score, matched } = scoreScenario(scenario, tokens);
      if (score <= 0) continue;
      results.push({ scenario, score, matched });
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
    const scenario = normalizeScenario({
      ...input,
      id: input.id ?? newScenarioID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      scope,
    });
    // Serialize the check-then-append so two concurrent learn calls can't both
    // pass the duplicate check and write the same scenario twice (M13). The
    // critical section also caps file growth.
    return this.serializeWrite(async () => {
      if (this.hasDuplicate(scenario)) return null;
      const path = scope === 'personal' ? this.personalPath : this.projectPath;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(scenario)}\n`, { mode: 0o600 });
      await chmod(path, 0o600).catch(() => undefined);
      this.pruneIfTooLong(path, scope);
      return scenario;
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
      const scenarios = readJSONL(path, scope);
      if (scenarios.length <= MAX_SCENARIOS_PER_FILE) return;
      const kept = scenarios.slice(scenarios.length - MAX_SCENARIOS_PER_FILE);
      writeFileSync(path, `${kept.map((s) => JSON.stringify(s)).join('\n')}\n`, { mode: 0o600 });
    } catch {
      // Best effort — a prune failure must not break learning.
    }
  }

  async learnFromText(text: string, sourceSessionId?: string): Promise<IntelligenceScenario[]> {
    const cleaned = redact(text);
    const learned: IntelligenceScenario[] = [];
    for (const candidate of extractScenarios(cleaned, sourceSessionId)) {
      const projectSaved = await this.append({ ...candidate, scope: 'project' });
      if (projectSaved) learned.push(projectSaved);
      const personalSaved = await this.append({ ...candidate, scope: 'personal' });
      if (personalSaved) learned.push(personalSaved);
    }
    return learned;
  }

  private hasDuplicate(scenario: IntelligenceScenario): boolean {
    const wantedTitle = normalizeKey(scenario.title);
    const wantedCategory = normalizeKey(scenario.category);
    const path = scenario.scope === 'personal' ? this.personalPath : this.projectPath;
    return readJSONL(path, scenario.scope).some((existing) => {
      if (existing.id === scenario.id) return true;
      return (
        normalizeKey(existing.title) === wantedTitle &&
        normalizeKey(existing.category) === wantedCategory
      );
    });
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
  const fields: Array<[string, number, string]> = [
    [s.title, 7, 'title'],
    [s.category, 5, 'category'],
    [s.triggers.join(' '), 8, 'triggers'],
    [s.technologies.join(' '), 6, 'technology'],
    [s.recommendedChecks.join(' '), 5, 'recommendedChecks'],
    [s.avoidMissing.join(' '), 4, 'avoidMissing'],
    [s.lesson, 2, 'lesson'],
  ];
  let score = 0;
  const matched = new Set<string>();
  for (const token of queryTokens) {
    for (const [text, weight, label] of fields) {
      if (!tokenMatches(text, token)) continue;
      score += weight;
      matched.add(`${label}:${token}`);
    }
  }
  if (score > 0) score += s.confidence;
  return { score, matched: [...matched] };
}

function tokenMatches(text: string, token: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(token)) return true;
  return token.includes('.') && lower.includes(token.replace(/\./g, ' '));
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
