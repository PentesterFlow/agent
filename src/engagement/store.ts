// Operator-authored engagement notes — a transcript-independent context file
// that is always injected into the system prompt, regardless of what the
// conversation summary happens to capture. This is the durable backbone the
// auto-generated SessionMemory drifts around: scope / rules of engagement,
// out-of-scope hosts, program rules, credential placeholders, and standing
// objectives the operator wants enforced on every turn.
//
// Two scopes are read and concatenated (mirrors IntelligenceStore):
//   - project: ./.pentesterflow/engagement.md   (this engagement)
//   - personal: ~/.pentesterflow/engagement.md  (defaults across engagements)
// Personal notes come first (general defaults), project notes last so the
// most specific context is nearest the end of the block.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Hard cap on the combined notes so a runaway file can't dominate the prompt.
// Engagement notes are meant to be concise; anything past this is truncated
// with a visible marker rather than silently dropped.
export const ENGAGEMENT_CHAR_LIMIT = 6000;

export interface EngagementStoreOptions {
  cwd?: string;
  home?: string;
}

export class EngagementStore {
  readonly projectPath: string;
  readonly personalPath: string;

  constructor(opts: EngagementStoreOptions = {}) {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const home = opts.home ?? homedir();
    this.projectPath = join(cwd, '.pentesterflow', 'engagement.md');
    this.personalPath = join(home, '.pentesterflow', 'engagement.md');
  }

  /**
   * Read both scopes (best-effort; a missing or unreadable file contributes
   * nothing) and return the combined notes, capped to ENGAGEMENT_CHAR_LIMIT.
   * Returns '' when there is nothing to inject.
   */
  load(): string {
    const parts: string[] = [];
    const personal = readText(this.personalPath);
    if (personal) parts.push(personal);
    const project = readText(this.projectPath);
    if (project) parts.push(project);

    const combined = parts.join('\n\n').trim();
    if (combined.length <= ENGAGEMENT_CHAR_LIMIT) return combined;
    return `${combined.slice(0, ENGAGEMENT_CHAR_LIMIT)}\n\n[engagement notes truncated at ${ENGAGEMENT_CHAR_LIMIT} characters — keep them concise]`;
  }
}

function readText(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}
