// @-file mention expansion: scan the user message for `@path` tokens, append a
// "Referenced files" block with the inlined contents, refuse sensitive
// paths inline (the model has to use file_read to get them after a
// permission prompt).

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { decodeUtf8Capped } from '../tools/file.js';
import { isSensitivePath } from '../tools/sensitive.js';

const MENTION_RE = /(^|[\s("'`])@(\S+)/g;
const INLINE_BYTE_CAP = 64 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.next', 'dist', 'build', '.cache']);
const REBUILD_COOLDOWN_MS = 2000;
const INDEX_FILE_CAP = 5000;
const INDEX_DIR_CAP = 1000;
const INDEX_DEPTH_CAP = 12;

let indexCwd = '';
let indexBuiltAt = 0;
let mentionIndex: Map<string, string[]> | null = null;

export function expandFileMentions(input: string): string {
  const mentions = extractMentions(input);
  if (mentions.length === 0) return input;

  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const raw of mentions) {
    const { resolved, note } = resolveMention(raw);
    if (note) {
      blocks.push(`### @${raw}\n[${note}]`);
      continue;
    }
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);

    // Resolve symlinks before the sensitivity check and before reading. The
    // lexical `resolved` only normalizes `..`; a cwd symlink (e.g.
    // notes -> ~/.ssh/id_rsa) would otherwise slip past isSensitivePath and get
    // inlined into the prompt with no gate (H5). Match file.ts: check + read the
    // real path.
    const real = realResolveSync(resolved);
    if (isSensitivePath(resolved) || isSensitivePath(real)) {
      blocks.push(
        `### @${raw}\n[Refusing to inline sensitive path ${real}. If you need this file in context, read it explicitly with the file_read tool (which will prompt for approval).]`,
      );
      continue;
    }

    let info: import('node:fs').Stats;
    try {
      info = statSync(real);
    } catch {
      blocks.push(`### @${raw}\n[File not found: ${raw}]`);
      continue;
    }
    if (info.isDirectory()) {
      blocks.push(`### @${raw}\n[File not found: ${raw}]`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(real);
    } catch (err) {
      blocks.push(`### @${raw}\n[Could not read file: ${(err as Error).message}]`);
      continue;
    }
    let body = buf.toString('utf8');
    let truncated = '';
    if (buf.byteLength > INLINE_BYTE_CAP) {
      body = decodeUtf8Capped(buf, INLINE_BYTE_CAP);
      truncated = `\n[... truncated ${buf.byteLength - INLINE_BYTE_CAP} bytes ...]`;
    }
    blocks.push(`### @${raw}\nPath: ${real}\n\n\`\`\`text\n${body}\n\`\`\`${truncated}`);
  }
  if (blocks.length === 0) return input;
  return `${input}\n\n# Referenced files\n\n${blocks.join('\n\n')}`;
}

function extractMentions(input: string): string[] {
  const out: string[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null = MENTION_RE.exec(input);
  while (m !== null) {
    const raw = cleanMentionPath(m[2] ?? '');
    if (raw && !/^https?:\/\//i.test(raw)) out.push(raw);
    m = MENTION_RE.exec(input);
  }
  return out;
}

function cleanMentionPath(raw: string): string {
  let p = raw.trim();
  p = p.replace(/^["']|["']$/g, '');
  p = p.replace(/["'.,;:)]+$/g, '');
  if (p.startsWith('~/')) {
    const home = homedir();
    if (home) p = join(home, p.slice(2));
  }
  return p;
}

/** Symlink-resolve a path (parent-dir fallback for the leaf), mirroring
 *  file.ts realResolve but synchronous. Falls back to the lexical path. */
function realResolveSync(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    try {
      return resolve(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

function resolveMention(raw: string): { resolved: string; note: string } {
  const candidate = isAbsolute(raw) ? raw : resolve(raw);
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return { resolved: candidate, note: '' };
  }

  if (/[/\\]/.test(raw)) {
    return { resolved: '', note: `File not found: ${raw}` };
  }

  const matches = findByBaseName(raw, 6);
  if (matches.length === 0) return { resolved: '', note: `File not found: ${raw}` };
  if (matches.length === 1) return { resolved: matches[0] ?? '', note: '' };
  return {
    resolved: '',
    note: `Ambiguous file mention. Matches:\n${matches.join('\n')}`,
  };
}

function findByBaseName(name: string, limit: number): string[] {
  const cwd = process.cwd();
  if (indexCwd !== cwd || mentionIndex === null) {
    mentionIndex = buildIndex(cwd);
    indexCwd = cwd;
    indexBuiltAt = Date.now();
  }
  let matches = mentionIndex.get(name) ?? [];
  if (matches.length === 0 && Date.now() - indexBuiltAt > REBUILD_COOLDOWN_MS) {
    mentionIndex = buildIndex(cwd);
    indexBuiltAt = Date.now();
    matches = mentionIndex.get(name) ?? [];
  }
  return [...matches].sort().slice(0, limit);
}

function buildIndex(cwd: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  walk(cwd, idx, { files: 0, dirs: 0 }, 0);
  return idx;
}

function walk(
  dir: string,
  idx: Map<string, string[]>,
  state: { files: number; dirs: number },
  depth: number,
): void {
  if (state.files >= INDEX_FILE_CAP || state.dirs >= INDEX_DIR_CAP || depth > INDEX_DEPTH_CAP) {
    return;
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (state.files >= INDEX_FILE_CAP || state.dirs >= INDEX_DIR_CAP) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      state.dirs += 1;
      walk(join(dir, e.name), idx, state, depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    const full = join(dir, e.name);
    const arr = idx.get(e.name);
    if (arr) arr.push(full);
    else idx.set(e.name, [full]);
    state.files += 1;
  }
}

// ---------- Public completion helpers (used by the @file picker UI) ----------

/**
 * Look up file paths whose basename matches `partial` (substring,
 * case-insensitive). Returns at most `limit` candidates sorted so that
 * a starts-with match outranks a contains match, ties broken
 * alphabetically. Returns the empty array on a miss.
 *
 * The index is the same one expandFileMentions uses — populated on
 * first call and re-walked on cold cwd misses (cooldown-throttled).
 */
export function mentionCandidates(partial: string, limit = 8): string[] {
  if (!partial) return [];
  ensureIndex();
  const needle = partial.toLowerCase();
  const cwd = process.cwd();
  const starts: Array<{ name: string; path: string }> = [];
  const contains: Array<{ name: string; path: string }> = [];

  if (!mentionIndex) return [];
  for (const [name, paths] of mentionIndex.entries()) {
    const lower = name.toLowerCase();
    if (lower === needle || lower.startsWith(needle)) {
      for (const p of paths) starts.push({ name, path: p });
    } else if (lower.includes(needle)) {
      for (const p of paths) contains.push({ name, path: p });
    }
  }
  const sort = (a: { name: string; path: string }, b: { name: string; path: string }) =>
    a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  starts.sort(sort);
  contains.sort(sort);

  const combined = [...starts, ...contains].slice(0, limit);
  // Return paths relative to cwd when possible so the picker reads short.
  return combined.map(({ path }) => relativize(path, cwd));
}

function ensureIndex(): void {
  const cwd = process.cwd();
  if (indexCwd !== cwd || mentionIndex === null) {
    mentionIndex = buildIndex(cwd);
    indexCwd = cwd;
    indexBuiltAt = Date.now();
  }
}

function relativize(path: string, cwd: string): string {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

// ---------- Directory-aware picker ----------

/**
 * One candidate in the @file picker. `display` is what the user sees;
 * `insert` is the text that replaces the `@<partial>` (without the
 * leading `@`). Directories end with `/` in both; files don't.
 */
export interface MentionCandidate {
  display: string;
  insert: string;
  isDir: boolean;
}

/**
 * Split a typed mention into its directory prefix (everything up to and
 * including the final `/`) and the trailing partial name being filtered.
 *
 *   parseMentionPath("src/ag")    → { dir: "src/", base: "ag" }
 *   parseMentionPath("READ")       → { dir: "",     base: "READ" }
 *   parseMentionPath("src/")       → { dir: "src/", base: "" }
 *   parseMentionPath("../")        → { dir: "../",  base: "" }
 *   parseMentionPath("../tools/x") → { dir: "../tools/", base: "x" }
 */
export function parseMentionPath(partial: string): { dir: string; base: string } {
  const lastSlash = partial.lastIndexOf('/');
  if (lastSlash < 0) return { dir: '', base: partial };
  return { dir: partial.slice(0, lastSlash + 1), base: partial.slice(lastSlash + 1) };
}

const PICKER_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache']);

/**
 * List directory entries the user might want to pick. Resolves `dir`
 * relative to cwd (also expands `~/`), filters by `base` substring
 * (case-insensitive, dot-files hidden unless base starts with `.`),
 * and prepends `..` whenever the resolved directory has a parent so the
 * user can ascend the tree.
 *
 * Directories sort first within each match class so they're easy to
 * spot. Returns at most `limit` candidates.
 */
export function listMentionDir(dir: string, base: string, limit = 12): MentionCandidate[] {
  let absDir: string;
  if (!dir) {
    absDir = process.cwd();
  } else if (dir.startsWith('~/')) {
    const home = homedir();
    absDir = home ? join(home, dir.slice(2)) : resolve(dir);
  } else {
    absDir = resolve(dir);
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const needle = base.toLowerCase();
  const showHidden = base.startsWith('.');
  const starts: MentionCandidate[] = [];
  const contains: MentionCandidate[] = [];

  // `..` entry — only when we can actually ascend. We compare against
  // the filesystem root to avoid infinite ascension at the top.
  if (hasParent(absDir)) {
    const insert = `${dir}../`;
    // Always include `..` so the user can step out even when nothing
    // in `base` matches.
    if (!needle || '..'.startsWith(needle) || '../'.startsWith(needle)) {
      starts.push({ display: '../', insert, isDir: true });
    }
  }

  for (const e of entries) {
    if (PICKER_SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.') && !showHidden) continue;

    const isDir = e.isDirectory();
    const lower = e.name.toLowerCase();
    if (needle && !lower.includes(needle)) continue;

    const display = isDir ? `${e.name}/` : e.name;
    const insert = `${dir}${e.name}${isDir ? '/' : ''}`;
    const cand: MentionCandidate = { display, insert, isDir };

    if (!needle || lower.startsWith(needle)) starts.push(cand);
    else contains.push(cand);
  }

  const sort = (a: MentionCandidate, b: MentionCandidate) => {
    // .. always pinned to the top.
    if (a.display === '../') return -1;
    if (b.display === '../') return 1;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.display.localeCompare(b.display);
  };
  starts.sort(sort);
  contains.sort(sort);

  return [...starts, ...contains].slice(0, limit);
}

function hasParent(absDir: string): boolean {
  const parent = resolve(absDir, '..');
  return parent !== absDir;
}

/**
 * Given the current input value, return the position + partial of the
 * active `@<partial>` token (the one the user is editing), or null.
 *
 * Active means: the last word starts with `@`, has no whitespace after
 * the @ marker, and isn't a URL (`@http...`).
 */
export function findActiveMention(input: string): { at: number; partial: string } | null {
  // Walk back from end of input to the most recent whitespace or start.
  let i = input.length - 1;
  while (i >= 0) {
    const ch = input[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n') return null;
    if (ch === '@') {
      // Must be at start of input or preceded by whitespace / open paren.
      const prev = i > 0 ? (input[i - 1] ?? '') : '';
      if (i === 0 || /[\s("'`]/.test(prev)) {
        const partial = input.slice(i + 1);
        if (/^https?:/i.test(partial)) return null;
        return { at: i, partial };
      }
      return null;
    }
    i -= 1;
  }
  return null;
}

// Re-exports useful for tests / callers.
export { basename, dirname };
