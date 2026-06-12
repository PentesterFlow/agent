// File-only structured logger.: writes JSON lines
// to ~/.pentesterflow/logs/pentesterflow.log, never to stdout/stderr (the
// TUI owns those), rotates at 4 MB by keeping pentesterflow.log.1.
//
// pino under the hood. Default logger is no-op so callers don't need to
// error-handle setup.
//
// L8 (historical, from AUDIT.md): rotation used to happen only at init().
// Now has throttled mid-run checks (every 100 writes) + generational rename
// (up to .3) via maybeRotate() + open(). Long sessions stay bounded.

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pino, { type Logger } from 'pino';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LOG_GENERATIONS = 3;
// Re-check the file size every N writes rather than on each one, so the hot
// path stays a single pino call most of the time.
const ROTATE_CHECK_EVERY = 100;

let current: Logger = pino({ enabled: false });
let currentStream: ReturnType<typeof pino.destination> | null = null;
let currentTarget = '';
let writesSinceCheck = 0;

/**
 * Initialise the logger. Opens or creates the log file at `path` and
 * installs a pino logger that writes to it. If `path` is empty, defaults
 * to `~/.pentesterflow/logs/pentesterflow.log`. On any setup error the
 * logger stays disabled so the caller doesn't need to error-handle.
 */
export function init(path?: string): void {
  const target = path && path.length > 0 ? path : defaultLogPath();
  if (!target) return;
  currentTarget = target;
  open(target);
}

function open(target: string): void {
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rotateIfTooBig(target);
    // Sync writes: a short-lived CLI command (--list-skills, --version,
    // --list-tools) shouldn't have to await pino's async drain on exit.
    // The throughput cost is irrelevant for this scale of logging.
    const stream = pino.destination({ dest: target, sync: true, append: true });
    const prev = currentStream;
    currentStream = stream;
    current = pino(
      {
        base: { pid: process.pid },
        timestamp: pino.stdTimeFunctions.isoTime,
        level: process.env.PENTESTERFLOW_LOG_LEVEL ?? 'info',
      },
      stream,
    );
    // Close the previous destination (if reopening for a rotation) so its fd on
    // the rotated-out file doesn't leak.
    if (prev) {
      try {
        prev.end();
      } catch {
        /* best effort */
      }
    }
  } catch {
    // Stay disabled on any setup failure.
    current = pino({ enabled: false });
    currentStream = null;
  }
}

function defaultLogPath(): string | undefined {
  const home = homedir();
  if (!home) return undefined;
  return join(home, '.pentesterflow', 'logs', 'pentesterflow.log');
}

function rotateIfTooBig(path: string): void {
  if (!existsSync(path)) return;
  try {
    const info = statSync(path);
    if (info.size <= MAX_LOG_BYTES) return;
    // Generational shift so an old log isn't clobbered: .log.(N-1) -> .log.N,
    // …, .log.1 -> .log.2, then .log -> .log.1.
    for (let i = MAX_LOG_GENERATIONS - 1; i >= 1; i -= 1) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
  } catch {
    // Best effort.
  }
}

/**
 * Throttled mid-run rotation. Rotation only happened at init() before, so a
 * long-running session grew the log unbounded past the cap (L8). After every
 * ROTATE_CHECK_EVERY writes we re-check the size and reopen on a fresh file if
 * it has grown too large.
 */
function maybeRotate(): void {
  if (!currentTarget) return;
  writesSinceCheck += 1;
  if (writesSinceCheck < ROTATE_CHECK_EVERY) return;
  writesSinceCheck = 0;
  try {
    if (existsSync(currentTarget) && statSync(currentTarget).size > MAX_LOG_BYTES) {
      open(currentTarget);
    }
  } catch {
    // Best effort.
  }
}

export function logger(): Logger {
  return current;
}

export function info(msg: string, args?: Record<string, unknown>): void {
  current.info(args ?? {}, msg);
  maybeRotate();
}

export function warn(msg: string, args?: Record<string, unknown>): void {
  current.warn(args ?? {}, msg);
  maybeRotate();
}

export function error(msg: string, args?: Record<string, unknown>): void {
  current.error(args ?? {}, msg);
  maybeRotate();
}

export function debug(msg: string, args?: Record<string, unknown>): void {
  current.debug(args ?? {}, msg);
  maybeRotate();
}
