// End-to-end gating: a permission-required tool run through the Registry must
// NOT consult the prompter when wrapped in a YoloPrompter that's armed. This
// is the exact path the agent uses (Registry.execute(..., prompter)), so it
// proves --yolo suppresses the modal for ordinary tools like `http`.

import { describe, expect, it } from 'vitest';
import {
  type Decision,
  type Prompter,
  type Request,
  YoloPrompter,
} from '../permission/permission.js';
import { Registry } from './registry.js';
import type { Tool } from './types.js';

/** A permission-required tool standing in for `http` / `shell`. */
class GatedTool implements Tool {
  ran = false;
  name() {
    return 'http';
  }
  description() {
    return 'gated';
  }
  schema() {
    return { type: 'object' };
  }
  requiresPermission() {
    return true;
  }
  async run() {
    this.ran = true;
    return 'ok';
  }
}

/** Records whether it was ever asked. */
class SpyPrompter implements Prompter {
  calls: Request[] = [];
  constructor(private readonly decision: Decision = 'deny') {}
  async ask(req: Request): Promise<Decision> {
    this.calls.push(req);
    return this.decision;
  }
}

describe('Registry permission gating under YOLO', () => {
  it('auto-approves a permission-required tool without consulting the prompter', async () => {
    const reg = new Registry();
    const tool = new GatedTool();
    reg.register(tool);
    const inner = new SpyPrompter('deny'); // would block if ever asked
    const yolo = new YoloPrompter(inner, true);

    const out = await reg.execute(
      'http',
      { url: 'http://example.test/' },
      new AbortController().signal,
      yolo,
    );

    expect(out).toBe('ok');
    expect(tool.ran).toBe(true);
    expect(inner.calls).toHaveLength(0); // no modal was published
  });

  it('does prompt (and can deny) when YOLO is off', async () => {
    const reg = new Registry();
    reg.register(new GatedTool());
    const inner = new SpyPrompter('deny');
    const yolo = new YoloPrompter(inner, false);

    await expect(
      reg.execute('http', { url: 'http://example.test/' }, new AbortController().signal, yolo),
    ).rejects.toThrow(/permission denied/);
    expect(inner.calls).toHaveLength(1);
  });
});
