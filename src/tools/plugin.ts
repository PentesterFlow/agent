// Command-plugin tool. A user-configured external binary that receives
// JSON args on stdin and emits stdout. The model sees it as just another
// tool.

import { spawn } from 'node:child_process';
import type { PluginConfig } from '../config/config.js';
import type { Prompter } from '../permission/permission.js';
import type { Tool } from './types.js';

const PLUGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024;

export class CommandPluginTool implements Tool {
  private readonly cfg: PluginConfig;

  constructor(cfg: PluginConfig) {
    this.cfg = cfg;
  }

  name(): string {
    return this.cfg.name;
  }

  description(): string {
    return (
      this.cfg.description ||
      'External command plugin. Receives JSON arguments on stdin and returns stdout.'
    );
  }

  schema(): Record<string, unknown> {
    return this.cfg.schema ?? { type: 'object', additionalProperties: true };
  }

  requiresPermission(): boolean {
    return this.cfg.requires_permission;
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    return {
      summary: `plugin: ${this.cfg.name}`,
      detail: `${this.cfg.command} ${this.cfg.args.join(' ')}\nstdin:\n${JSON.stringify(args, null, 2)}`,
    };
  }

  async run(
    args: Record<string, unknown>,
    parentSignal: AbortSignal,
    _p: Prompter,
  ): Promise<string> {
    if (!this.cfg.command) {
      throw new Error(`plugin ${this.cfg.name} has no command`);
    }
    return runPlugin(this.cfg.command, this.cfg.args, args, parentSignal);
  }
}

function runPlugin(
  command: string,
  argv: string[],
  args: Record<string, unknown>,
  parentSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolveOut, rejectOut) => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PLUGIN_TIMEOUT_MS);
    let timedOut = false;
    timer.unref?.();

    const child = spawn(command, argv, { signal: controller.signal });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdoutTotal = 0;
    let stderrTotal = 0;

    child.stdout.on('data', (c: Buffer) => {
      stdoutTotal += c.length;
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(c);
        stdoutLen += c.length;
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderrTotal += c.length;
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(c);
        stderrLen += c.length;
      }
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      const stdout = truncate(Buffer.concat(stdoutChunks).toString('utf8'), stdoutTotal);
      const stderr = truncate(Buffer.concat(stderrChunks).toString('utf8'), stderrTotal);

      if (timedOut) {
        rejectOut(new Error(`plugin timed out after ${PLUGIN_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (code === 0) {
        resolveOut(stderr ? `${stdout}\nstderr:\n${stderr}` : stdout);
        return;
      }
      const sigSuffix = sig ? ` (signal: ${sig})` : '';
      rejectOut(
        new Error(`plugin exited ${code}${sigSuffix}${stderr ? `: ${stderr.trim()}` : ''}`),
      );
    });

    child.on('error', (err) => {
      if (controller.signal.aborted && err.name === 'AbortError') return;
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      rejectOut(err);
    });

    // Send args on stdin and close it so the child knows the input is done.
    // A plugin that exits before reading raises an async EPIPE on this stream;
    // without an 'error' listener Node promotes it to an uncaughtException that
    // kills the whole CLI (H8). Swallow it here — the child's exit/error
    // handlers above already surface the real failure.
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(args));
    child.stdin.end();
  });
}

function truncate(s: string, total: number): string {
  if (total <= MAX_OUTPUT_BYTES) return s;
  return `${s.slice(0, MAX_OUTPUT_BYTES)}\n[... truncated ${total - MAX_OUTPUT_BYTES} bytes ...]`;
}
