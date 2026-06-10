// GlobTool + GrepTool. Glob uses fast-glob (handles ** and brace
// expansion); grep walks matched files line-by-line and prints
// path:line:match.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import fg from 'fast-glob';
import type { Prompter } from '../permission/permission.js';
import { gateSensitivePath } from './file.js';
import { type Tool, argBool, argNumber, argString } from './types.js';

const GREP_FILE_BYTE_CAP = 5 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  'vendor',
  '__pycache__',
]);

export class GlobTool implements Tool {
  name(): string {
    return 'GlobTool';
  }
  description(): string {
    return 'Find files by glob pattern. Supports *, ?, character classes, and ** for recursive matching. Returns matching paths sorted by name.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, for example "**/*.go" or "internal/**/*.go".',
        },
        path: {
          type: 'string',
          description: 'Optional base directory. Defaults to current working directory.',
        },
        limit: { type: 'integer', description: 'Optional max matches. Defaults to 200.' },
      },
      required: ['pattern'],
    };
  }
  requiresPermission(): boolean {
    return false;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const pattern = argString(args, 'pattern');
    if (!pattern) throw new Error('pattern is required');
    const base = argString(args, 'path') || '.';
    const limit = Math.max(1, Math.floor(argNumber(args, 'limit') ?? 200));

    await gateSearchInputs(p, base, pattern, signal);

    const matches = await globFiles(base, pattern, limit, signal);
    for (const file of matches) {
      await gateSensitivePath(p, file, 'search', signal);
    }
    if (matches.length === 0) return 'no matches';
    return matches.join('\n');
  }
}

export class GrepTool implements Tool {
  name(): string {
    return 'GrepTool';
  }
  description(): string {
    return 'Search file contents using a regular expression. Use glob to narrow files, for example "**/*.go". Returns path:line:match.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: {
          type: 'string',
          description: 'Optional base directory or file. Defaults to current working directory.',
        },
        glob: { type: 'string', description: 'Optional file glob filter, for example "**/*.go".' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        limit: { type: 'integer', description: 'Optional max matches. Defaults to 200.' },
      },
      required: ['pattern'],
    };
  }
  requiresPermission(): boolean {
    return false;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const rawPattern = argString(args, 'pattern');
    if (!rawPattern) throw new Error('pattern is required');
    const ignoreCase = argBool(args, 'ignore_case');
    const flags = ignoreCase ? 'i' : '';
    let re: RegExp;
    try {
      re = new RegExp(rawPattern, flags);
    } catch (err) {
      throw new Error(`invalid regex: ${(err as Error).message}`);
    }

    const base = argString(args, 'path') || '.';
    const glob = argString(args, 'glob') || '**/*';
    const limit = Math.max(1, Math.floor(argNumber(args, 'limit') ?? 200));

    await gateSearchInputs(p, base, glob, signal);

    const files = await globFiles(base, glob, 10_000, signal);

    const out: string[] = [];
    for (const file of files) {
      if (signal.aborted) throw new Error('aborted');
      let info: import('node:fs').Stats;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (info.isDirectory() || info.size > GREP_FILE_BYTE_CAP) continue;
      await gateSensitivePath(p, file, 'search', signal);
      const matches = await grepFile(file, re, limit - out.length, signal);
      out.push(...matches);
      if (out.length >= limit) break;
    }

    if (out.length === 0) return 'no matches';
    if (out.length >= limit) out.push(`[... limited to ${limit} matches ...]`);
    return out.join('\n');
  }
}

async function globFiles(
  base: string,
  pattern: string,
  limit: number,
  signal: AbortSignal,
): Promise<string[]> {
  const absBase = resolve(base);
  const info = await stat(absBase);

  // Single-file case: match the base name against
  // the pattern; if it matches, return just that file.
  if (!info.isDirectory()) {
    const dir = dirname(absBase);
    const baseName = basename(absBase);
    const matches = await fg(pattern, { cwd: dir, dot: true, onlyFiles: true });
    return matches.some((m) => m === baseName || m.endsWith(`/${baseName}`)) ? [absBase] : [];
  }

  const results = await fg(pattern, {
    cwd: absBase,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: Array.from(SKIP_DIR_NAMES).map((n) => `**/${n}/**`),
  });
  if (signal.aborted) throw new Error('aborted');
  return results
    .slice(0, limit)
    .map((rel) => resolve(absBase, rel))
    .sort();
}

async function gateSearchInputs(
  p: Prompter,
  base: string,
  pattern: string,
  signal: AbortSignal,
): Promise<void> {
  await gateSensitivePath(p, resolve(base), 'search', signal);
  const prefix = absoluteLiteralPrefix(pattern);
  if (prefix) await gateSensitivePath(p, prefix, 'search', signal);
}

function absoluteLiteralPrefix(pattern: string): string {
  if (!isAbsolute(pattern)) return '';
  const idx = pattern.search(/[*?[\]{}()!]/);
  const prefix = idx >= 0 ? pattern.slice(0, idx) : pattern;
  return prefix ? resolve(prefix) : '';
}

async function grepFile(
  path: string,
  re: RegExp,
  remaining: number,
  signal: AbortSignal,
): Promise<string[]> {
  if (remaining <= 0) return [];
  const out: string[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      if (signal.aborted) break;
      lineNo += 1;
      // Reset regex state for global flag (we don't set /g but be safe).
      re.lastIndex = 0;
      if (re.test(line)) {
        out.push(`${path}:${lineNo}:${line}`);
        if (out.length >= remaining) break;
      }
    }
  } catch {
    // Binary files / encoding issues — skip the rest silently.
  } finally {
    rl.close();
  }
  return out;
}
