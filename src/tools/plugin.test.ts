import { describe, expect, it } from 'vitest';
import { AlwaysAllow } from '../permission/permission.js';
import { CommandPluginTool } from './plugin.js';

describe('CommandPluginTool', () => {
  it('truncates large plugin output', async () => {
    const tool = new CommandPluginTool({
      name: 'big_plugin',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(300000))'],
      description: '',
      requires_permission: false,
    });

    const out = await tool.run({}, new AbortController().signal, new AlwaysAllow());

    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(140_000);
  });
});
