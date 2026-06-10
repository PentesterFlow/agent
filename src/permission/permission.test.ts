// Permission-flag behavior: YOLO auto-approves EVERY request (no carve-outs),
// matching --dangerously-skip-permissions; non-YOLO defers to the real
// prompter.

import { describe, expect, it } from 'vitest';
import type { Decision, Prompter, Request } from './permission.js';
import { YoloPrompter } from './permission.js';

/** Records every request and answers with a scripted decision. */
class ScriptedPrompter implements Prompter {
  readonly seen: Request[] = [];
  constructor(private readonly decision: Decision) {}
  async ask(req: Request): Promise<Decision> {
    this.seen.push(req);
    return this.decision;
  }
}

describe('YoloPrompter', () => {
  it('auto-approves ordinary requests without prompting', async () => {
    const inner = new ScriptedPrompter('deny');
    const y = new YoloPrompter(inner, true);
    expect(await y.ask({ tool: 'shell', summary: 's', detail: 'd' })).toBe('allow-once');
    expect(inner.seen).toHaveLength(0);
  });

  it('auto-approves sensitive/SSRF gates too — YOLO has no carve-outs', async () => {
    const inner = new ScriptedPrompter('deny');
    const y = new YoloPrompter(inner, true);
    // A gate request (sensitive file / private host) that previously deferred
    // to the prompter is now auto-approved under YOLO.
    const decision = await y.ask({
      tool: 'file',
      summary: 's',
      detail: 'd',
      noSessionCache: true,
    });
    expect(decision).toBe('allow-once');
    expect(inner.seen).toHaveLength(0);
  });

  it('defers to the real prompter when YOLO is off', async () => {
    const inner = new ScriptedPrompter('deny');
    const y = new YoloPrompter(inner, false);
    expect(await y.ask({ tool: 'shell', summary: 's', detail: 'd' })).toBe('deny');
    expect(inner.seen).toHaveLength(1);
  });
});
