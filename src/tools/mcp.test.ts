import { describe, expect, it } from 'vitest';
import { AlwaysAllow } from '../permission/permission.js';
import type { MCPSession } from './mcp.js';
import { MCPTool } from './mcp.js';

describe('MCPTool', () => {
  it('formats text MCP errors without raw content JSON', async () => {
    const session = {
      serverName: 'browser',
      callTool: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'Error: WebSocket response timeout after 30000ms' }],
      }),
    } as unknown as MCPSession;
    const tool = new MCPTool(
      session,
      'mcp_browser_browser_click',
      'browser_click',
      'Click in browser',
      { type: 'object' },
    );

    await expect(tool.run({}, new AbortController().signal, new AlwaysAllow())).rejects.toThrow(
      'Browser Click failed: WebSocket response timeout after 30000ms',
    );
    await expect(tool.run({}, new AbortController().signal, new AlwaysAllow())).rejects.not.toThrow(
      'isError',
    );
  });

  it('truncates large successful MCP results', async () => {
    const session = {
      serverName: 'browser',
      callTool: async () => ({
        isError: false,
        content: [{ type: 'text', text: 'a'.repeat(200_000) }],
      }),
    } as unknown as MCPSession;
    const tool = new MCPTool(session, 'mcp_browser_big', 'big', 'Big output', {
      type: 'object',
    });

    const out = await tool.run({}, new AbortController().signal, new AlwaysAllow());

    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(140_000);
  });
});
