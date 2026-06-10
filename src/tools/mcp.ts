// MCP integration via @modelcontextprotocol/sdk. Each configured MCP
// server is spawned once at app launch, kept alive for the program's
// lifetime (Browser MCP needs persistent state for the browser tab),
// and its tools are auto-discovered as `mcp_<server>_<tool>`.

import { createInterface } from 'node:readline';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '../config/config.js';
import { warn } from '../logger/logger.js';
import type { Prompter } from '../permission/permission.js';
import { displayToolName, primaryToolArg } from './toolDisplay.js';
import type { Tool } from './types.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CLOSE_DEADLINE_MS = 3_000;
const MCP_RESULT_CHAR_CAP = 128 * 1024;

export class MCPSession {
  readonly serverName: string;
  private readonly client: MCPClient;
  private readonly transport: StdioClientTransport;
  private closed = false;

  constructor(serverName: string, client: MCPClient, transport: StdioClientTransport) {
    this.serverName = serverName;
    this.client = client;
    this.transport = transport;
  }

  static async open(server: MCPServerConfig): Promise<MCPSession> {
    if (!server.command) throw new Error(`mcp server ${server.name} has no command`);
    // `stderr: 'pipe'` so we can capture the child's stderr ourselves
    // instead of letting it inherit and clutter the user's terminal.
    // Browser MCP in particular logs a noisy infinite-recursion stack
    // trace from its own broken close() on shutdown — this routes
    // that (plus any real error) to our pino log file.
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env as Record<string, string> | undefined,
      stderr: 'pipe',
    });
    const client = new MCPClient({ name: 'pentesterflow', version: '0.1.0' }, { capabilities: {} });

    const timeout = setTimeout(() => {
      try {
        void transport.close();
      } catch {
        /* ignore */
      }
    }, HANDSHAKE_TIMEOUT_MS);
    try {
      await client.connect(transport);
    } finally {
      clearTimeout(timeout);
    }
    // After connect, transport.stderr is the child's piped stderr.
    // Forward each line to logger.warn so real errors are still
    // captured but the user doesn't see them in the TUI.
    forwardStderrToLog(transport, server.name);
    return new MCPSession(server.name, client, transport);
  }

  isClosed(): boolean {
    return this.closed;
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const resp = await this.client.listTools();
    return resp.tools as Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ isError: boolean; content: unknown }> {
    if (this.closed) throw new Error(`mcp session ${this.serverName} is closed`);
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal });
    return {
      isError: Boolean(result.isError),
      content: result.content,
    };
  }

  /** Close the session with a deadline so a misbehaving child can't hang shutdown. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closeOp = (async () => {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
      try {
        await this.transport.close();
      } catch {
        /* ignore */
      }
    })();
    await Promise.race([
      closeOp,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          warn('mcp: close deadline exceeded; abandoning child', { server: this.serverName });
          resolve();
        }, CLOSE_DEADLINE_MS),
      ),
    ]);
  }
}

/** Wrap a discovered MCP tool as a pentesterflow Tool the registry knows about. */
export class MCPTool implements Tool {
  private readonly session: MCPSession;
  private readonly toolName: string;
  private readonly remoteName: string;
  private readonly desc: string;
  private readonly schemaObj: Record<string, unknown>;

  constructor(
    session: MCPSession,
    toolName: string,
    remoteName: string,
    desc: string,
    schemaObj: Record<string, unknown>,
  ) {
    this.session = session;
    this.toolName = toolName;
    this.remoteName = remoteName;
    this.desc = desc;
    this.schemaObj = schemaObj;
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    return this.desc
      ? `MCP ${this.session.serverName}: ${this.desc}`
      : `MCP tool from ${this.session.serverName}`;
  }

  schema(): Record<string, unknown> {
    return this.schemaObj;
  }

  requiresPermission(): boolean {
    return true;
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    // Tools with a single obvious argument (e.g. the browser tool's `url`)
    // show a friendly label + bare value instead of raw JSON.
    const primary = primaryToolArg(this.toolName, args);
    if (primary !== null) {
      return { summary: displayToolName(this.toolName), detail: primary };
    }
    return { summary: `mcp: ${this.toolName}`, detail: JSON.stringify(args, null, 2) };
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, _p: Prompter): Promise<string> {
    const result = await this.session.callTool(this.remoteName, args, signal);
    if (result.isError) {
      throw new Error(formatMCPError(this.toolName, this.remoteName, result.content));
    }
    // Bound the content BEFORE the pretty-print so a hostile/compromised server's
    // oversized text block isn't first expanded into an even larger indented
    // string (M10). The MCP SDK still buffers the raw transport message itself —
    // a true byte cap would need transport-level support it doesn't expose — but
    // this stops the secondary doubling and caps the block count.
    const bounded = boundContent(result.content, MCP_RESULT_CHAR_CAP);
    return truncateString(JSON.stringify(bounded, null, 2), MCP_RESULT_CHAR_CAP);
  }
}

const MCP_MAX_CONTENT_BLOCKS = 200;

/** Recursively cap string fields and array lengths in MCP content so the
 *  downstream JSON.stringify can't allocate an unbounded string. */
function boundContent(content: unknown, cap: number): unknown {
  if (typeof content === 'string') return content.length > cap ? content.slice(0, cap) : content;
  if (Array.isArray(content)) {
    const head = content.slice(0, MCP_MAX_CONTENT_BLOCKS).map((b) => boundContent(b, cap));
    if (content.length > MCP_MAX_CONTENT_BLOCKS) {
      head.push({
        type: 'text',
        text: `[... ${content.length - MCP_MAX_CONTENT_BLOCKS} more content blocks truncated ...]`,
      });
    }
    return head;
  }
  if (content && typeof content === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(content)) out[k] = boundContent(v, cap);
    return out;
  }
  return content;
}

function truncateString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n[... truncated ${s.length - cap} chars ...]`;
}

function formatMCPError(toolName: string, remoteName: string, content: unknown): string {
  const text = extractMCPText(content).trim();
  const label = displayToolName(toolName);
  if (text) return `${label} failed: ${text.replace(/^Error:\s*/i, '')}`;
  return `${label} failed: ${remoteName} returned an MCP error`;
}

function extractMCPText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Spawn `server`, perform the initialize handshake, and return both the
 * live session and the discovered tools (wrapped for our registry). The
 * caller owns the session and must close() it on shutdown.
 */
export async function discoverMCPTools(
  server: MCPServerConfig,
): Promise<{ session: MCPSession; tools: MCPTool[] }> {
  const session = await MCPSession.open(server);
  try {
    const remote = await session.listTools();
    const tools: MCPTool[] = [];
    for (const t of remote) {
      if (!t.name) continue;
      const schema = (t.inputSchema as Record<string, unknown> | undefined) ?? {
        type: 'object',
        additionalProperties: true,
      };
      const wrapped = new MCPTool(
        session,
        `mcp_${sanitize(server.name)}_${sanitize(t.name)}`,
        t.name,
        t.description ?? '',
        schema,
      );
      tools.push(wrapped);
    }
    return { session, tools };
  } catch (err) {
    await session.close();
    throw err;
  }
}

/**
 * Wire the MCP child's piped stderr into our pino log file so the
 * user's terminal stays quiet. Each non-empty line is logged with the
 * server name attached for grep-ability. Silently no-ops if the
 * transport hasn't exposed a stderr stream (some adapter versions
 * don't, or stderr was configured differently).
 */
function forwardStderrToLog(transport: StdioClientTransport, serverName: string): void {
  // The SDK types `stderr` as `Stream | null` (Node's base Stream),
  // but in practice it's always a Readable when constructed with
  // `stderr: 'pipe'`. We narrow via unknown to avoid a structural-type
  // mismatch; if the SDK ever swaps the field type we'd catch it at
  // runtime as `.on` being undefined.
  const stream = (transport as unknown as { stderr?: NodeJS.ReadableStream | null }).stderr;
  if (!stream || typeof (stream as { on?: unknown }).on !== 'function') return;
  const rl = createInterface({ input: stream });
  rl.on('line', (line) => {
    const trimmed = line.trimEnd();
    if (trimmed) warn('mcp child stderr', { server: serverName, line: trimmed });
  });
  // The readline closes itself when the stream EOFs (process exit); no
  // explicit cleanup needed.
  rl.on('error', () => {
    /* ignore — child gone */
  });
}

function sanitize(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9_]/.test(ch)) out += ch;
    else out += '_';
  }
  return out.replace(/^_+|_+$/g, '');
}
