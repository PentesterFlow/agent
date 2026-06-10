// read_payloads tool. Surfaces files living inside `<skill>/payloads/`
// so playbooks can ship curated wordlists (SQLi, XSS, SSTI, JWT, ...)
// and the agent can pull them on demand without inventing payloads from
// training memory alone.
//
// Path resolution walks the skill registry so the agent only needs to
// know the skill name + relative file path. We refuse any resolved path
// that escapes the skill's own directory — defends against the LLM
// passing `../../../etc/passwd` as `file`.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Prompter } from '../permission/permission.js';
import type { Registry as SkillRegistry } from '../skills/registry.js';
import { type Tool, argNumber, argString } from './types.js';

const MAX_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 16 * 1024;

export class ReadPayloadsTool implements Tool {
  private readonly skills: SkillRegistry;

  constructor(skills: SkillRegistry) {
    this.skills = skills;
  }

  name(): string {
    return 'read_payloads';
  }

  description(): string {
    return [
      'Read a curated payload list shipped with a skill. Each skill can carry a `payloads/` directory (e.g. `ssti/payloads/jinja2.txt`); this tool lists the available files for a skill or returns the contents of one.',
      '',
      'Use after loading a skill — many skills reference specific payload files by name in their body. Avoid inventing payloads from memory when a skill ships them: the on-disk lists are curated and class-aware.',
      '',
      'Examples:',
      '  read_payloads(skill="ssti", action="list")',
      '  read_payloads(skill="jwt", file="alg-confusion.txt")',
      '  read_payloads(skill="ssti", file="jinja2.txt", limit=50)',
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name whose payloads/ directory to read (e.g. "ssti", "jwt").',
        },
        action: {
          type: 'string',
          enum: ['list', 'read'],
          description:
            "'list' returns the filenames available under <skill>/payloads/. 'read' returns the contents of one file. Default: 'read' when file is given, 'list' when not.",
        },
        file: {
          type: 'string',
          description:
            'Relative path within <skill>/payloads/ (e.g. "jinja2.txt", "headers/forwarded.txt"). Required for action=read.',
        },
        limit: {
          type: 'number',
          description:
            'Cap number of lines returned (default 200, max 5000). Applies to action=read.',
        },
      },
      required: ['skill'],
    };
  }

  requiresPermission(): boolean {
    return false; // read-only inside the repo's own skill tree
  }

  async run(
    args: Record<string, unknown>,
    _signal: AbortSignal,
    _prompter: Prompter,
  ): Promise<string> {
    const skillName = argString(args, 'skill');
    if (!skillName) return 'error: skill is required';

    const skill = this.skills.get(skillName);
    if (!skill) return `error: skill "${skillName}" not loaded`;

    const skillDir = dirname(skill.path);
    const payloadsDir = join(skillDir, 'payloads');
    if (!existsSync(payloadsDir)) {
      return `skill "${skillName}" has no payloads/ directory at ${payloadsDir}`;
    }

    const file = argString(args, 'file');
    const action = argString(args, 'action') || (file ? 'read' : 'list');

    if (action === 'list') {
      return JSON.stringify(listFiles(payloadsDir), null, 2);
    }
    if (action !== 'read') return `error: unknown action "${action}"`;
    if (!file) return 'error: file is required for action=read';

    const resolved = resolve(payloadsDir, file);
    const rel = relative(payloadsDir, resolved);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      return `error: path "${file}" escapes <skill>/payloads/`;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return `error: not a file: ${file}`;
    }
    // Re-check containment against the symlink-resolved real paths: the lexical
    // check above is defeated by a symlink inside payloads/ (e.g.
    // payloads/evil -> /etc), and this tool reads without a permission prompt.
    if (!containedIn(payloadsDir, resolved)) {
      return `error: path "${file}" escapes <skill>/payloads/ via a symlink`;
    }
    const bytes = statSync(resolved).size;
    const limit = Math.max(1, Math.min(5000, argNumber(args, 'limit') ?? 200));
    const raw = readFileSync(resolved, 'utf8');
    const lines = raw.split('\n');
    const total = lines.length;
    const slice = lines.slice(0, limit);
    let body = slice.join('\n');
    if (body.length > MAX_PREVIEW_BYTES) {
      body = `${body.slice(0, MAX_PREVIEW_BYTES)}\n...<truncated; ${bytes} bytes on disk>`;
    }
    const truncated = total > limit ? `\n...<truncated at ${limit} of ${total} lines>` : '';
    return `# ${skillName}/${rel} — ${total} line(s), ${bytes} bytes\n${body}${truncated}`;
  }
}

/** True if `target` stays inside `base` after both are symlink-resolved. */
function containedIn(base: string, target: string): boolean {
  let realBase: string;
  let realTarget: string;
  try {
    realBase = realpathSync(base);
    realTarget = realpathSync(target);
  } catch {
    return false;
  }
  const rel = relative(realBase, realTarget);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const e of entries) {
    const p = join(dir, e);
    const info = statSync(p);
    if (info.isDirectory()) {
      out.push(...listFiles(p, prefix ? `${prefix}/${e}` : e));
      continue;
    }
    if (!info.isFile()) continue;
    // Skip binaries and giant lists silently — the agent shouldn't be
    // dumping multi-MB blobs into context.
    if (info.size > MAX_BYTES) continue;
    out.push(prefix ? `${prefix}/${e}` : e);
  }
  return out.sort();
}
