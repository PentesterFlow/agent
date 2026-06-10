// read_skill_file tool. Surfaces any auxiliary file shipped alongside a
// skill — scripts/, data/, templates/, payloads/, anything the skill
// author put next to their SKILL.md. Supersedes read_payloads for new
// skills (read_payloads still works, hardcoded to <skill>/payloads/).
//
// Path resolution walks the skill registry: the agent gives a skill
// name + a relative path within the skill's directory, and we resolve
// to the absolute file path. The resolved path is checked against the
// skill's own directory so `../` traversal can't escape into the
// repo, and SKILL.md itself is refused (the body is already loaded via
// load_skill — re-reading it through this tool would just duplicate
// content).

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Prompter } from '../permission/permission.js';
import type { Registry as SkillRegistry } from '../skills/registry.js';
import { type Tool, argNumber, argString } from './types.js';

const MAX_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 16 * 1024;

export class ReadSkillFileTool implements Tool {
  private readonly skills: SkillRegistry;

  constructor(skills: SkillRegistry) {
    this.skills = skills;
  }

  name(): string {
    return 'read_skill_file';
  }

  description(): string {
    return [
      'Read or list any auxiliary file shipped with a skill. Skills carry their own directory; this tool resolves paths relative to that directory and reads them safely.',
      '',
      'Use after loading a skill — skill bodies reference ${SKILL_DIR} for absolute paths; this tool is the skill-name-relative way to fetch the same file.',
      '',
      'Examples:',
      '  read_skill_file(skill="takeover", action="list")',
      '  read_skill_file(skill="takeover", path="payloads/fingerprints.json")',
      '  read_skill_file(skill="ssti", path="payloads/jinja2.txt", limit=50)',
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name whose directory to read from.' },
        action: {
          type: 'string',
          enum: ['list', 'read'],
          description:
            "'list' returns the filenames under the skill's directory (excluding SKILL.md). 'read' returns one file's contents. Default: 'read' when path is given, 'list' when not.",
        },
        path: {
          type: 'string',
          description:
            'Relative path within the skill directory (e.g. "payloads/jwt.txt", "scripts/check.sh", "data/x.json"). Required for action=read.',
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
    return false;
  }

  async run(args: Record<string, unknown>, _signal: AbortSignal, _p: Prompter): Promise<string> {
    const skillName = argString(args, 'skill');
    if (!skillName) return 'error: skill is required';
    const skill = this.skills.get(skillName);
    if (!skill) return `error: skill "${skillName}" not loaded`;

    const skillDir = dirname(skill.path);
    const path = argString(args, 'path');
    const action = argString(args, 'action') || (path ? 'read' : 'list');

    if (action === 'list') {
      return JSON.stringify(listFiles(skillDir), null, 2);
    }
    if (action !== 'read') return `error: unknown action "${action}"`;
    if (!path) return 'error: path is required for action=read';

    const resolved = resolve(skillDir, path);
    const rel = relative(skillDir, resolved);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      return `error: path "${path}" escapes the skill directory`;
    }
    if (rel === 'SKILL.md') {
      return 'error: SKILL.md is loaded via load_skill, not this tool';
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return `error: not a file: ${path}`;
    }
    // Re-check containment against the symlink-resolved real paths: the lexical
    // check above is defeated by a symlink inside the skill dir, and this tool
    // reads without a permission prompt.
    if (!containedIn(skillDir, resolved)) {
      return `error: path "${path}" escapes the skill directory via a symlink`;
    }
    const bytes = statSync(resolved).size;
    const limit = Math.max(1, Math.min(5000, argNumber(args, 'limit') ?? 200));
    const raw = readFileSync(resolved, 'utf8');
    const lines = raw.split('\n');
    const total = lines.length;
    let body = lines.slice(0, limit).join('\n');
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
    if (e === 'SKILL.md' && !prefix) continue; // hide the entrypoint
    const p = join(dir, e);
    const info = statSync(p);
    if (info.isDirectory()) {
      out.push(...listFiles(p, prefix ? `${prefix}/${e}` : e));
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_BYTES) continue;
    out.push(prefix ? `${prefix}/${e}` : e);
  }
  return out.sort();
}
