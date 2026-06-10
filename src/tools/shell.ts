// Shell + bash tools. Each invocation requires permission. A denylist
// blocks obviously destructive patterns up front so the model can't
// accidentally rm -rf / even with user consent. Output is truncated to
// keep context windows sane.

import { spawn } from 'node:child_process';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * Advisory denylist for catastrophic commands. This is defense-in-depth
 * behind the per-command permission prompt, NOT a security boundary — a
 * determined model can phrase destructive work around it. It exists to
 * catch obvious foot-guns (rm -rf of root/top-level dirs, fork bombs,
 * disk wipes) before they reach a hurried "allow".
 */
export const DENY_PATTERNS: RegExp[] = [
  // rm -rf targeting root or a single top-level dir (/, /*, /home, /home/).
  // Matches short (-rf, -fr) and long (--recursive --force) flag forms, in
  // either order; deeper paths like /home/user are left to the operator.
  /\brm\b(?=[^|;&\n]*\s-{1,2}[a-z-]*r)(?=[^|;&\n]*\s-{1,2}[a-z-]*f)[^|;&\n]*\s\/[^/\s]*\/?(?:\s|$)/i,
  /\brm\b(?=[^|;&\n]*\s-{1,2}[a-z-]*r)(?=[^|;&\n]*\s-{1,2}[a-z-]*f)[^|;&\n]*\s["']\/[^/"'\s]*\/?["'](?:\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}/i, // fork bomb
  /\bmkfs\b/i,
  /\bdd\b[^|;&\n]*\bof=\/dev\//i,
  />\s*\/dev\/sd[a-z]/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\bfind\b[^|;&\n]*\s-delete\b/i, // find / -delete
  /\bfind\b[^|;&\n]*\s-exec\s+rm\b/i, // find / -exec rm
];

const PORTABILITY_PATTERNS: Array<{ re: RegExp; message: string }> = [
  {
    re: /\bgrep\s+(?:-[A-Za-z]*P[A-Za-z]*|--perl-regexp)\b/,
    message:
      'grep -P/--perl-regexp is GNU-only and fails on macOS/BSD grep. Use grep -E, awk, sed, perl -ne, or jq instead.',
  },
  {
    re: /\bsed\s+-[A-Za-z]*r[A-Za-z]*\b/,
    message: 'sed -r is GNU-only. Use sed -E for portable extended regular expressions.',
  },
  {
    re: /\bbase64\s+[^|;&\n]*-[A-Za-z]*w\d*[A-Za-z]*\b/,
    message:
      'base64 -w is GNU-only. Omit wrapping flags on macOS/BSD, or strip newlines with tr -d "\\n".',
  },
  {
    re: /\breadlink\s+-[A-Za-z]*f[A-Za-z]*\b/,
    message:
      'readlink -f is GNU-only. Use python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" <path> or pwd -P based logic.',
  },
  {
    re: /\bdate\s+[^|;&\n]*-[A-Za-z]*d[A-Za-z]*\b/,
    message:
      'date -d is GNU-only. Use portable shell date handling or a short python3/perl snippet for date parsing.',
  },
  {
    re: /\bxargs\s+-[A-Za-z]*r[A-Za-z]*\b/,
    message:
      'xargs -r is GNU-only. Guard input explicitly before xargs for macOS/BSD compatibility.',
  },
  {
    re: /\bstat\s+-c\b/,
    message: 'stat -c is GNU-only. Use stat -f on macOS/BSD or a portable python3 os.stat snippet.',
  },
  {
    re: /\bsort\s+-[A-Za-z]*V[A-Za-z]*\b/,
    message: 'sort -V is GNU-only. Use plain sort or a small python3 version-sort snippet.',
  },
  {
    re: /(^|[|;&\s])timeout\s+\d/,
    message:
      'timeout is not available by default on macOS. Use the tool timeout_seconds argument or implement timeout in python3.',
  },
];

// Only rewrite `grep` at a command position (start of string or right after a
// shell separator), so a literal `grep -P ...` inside an `echo`/`awk` string is
// not matched and corrupted. The leading separator + whitespace are captured so
// the rewrite can re-emit them verbatim.
const GREP_P_RE =
  /(^|[\n|;&(])([ \t]*)grep\s+((?:(?:-[A-Za-z]+|--perl-regexp)\s+)*)((?:'[^']*')|(?:"[^"]*")|(?:\\.|[^\s|;&])+)([^|;&\n]*)/g;

export class ShellTool implements Tool {
  private readonly shellPath: string;
  private readonly toolName: string;

  constructor(shell = '/bin/sh', toolName = 'shell') {
    this.shellPath = shell;
    this.toolName = toolName;
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    return [
      'Run a shell command via /bin/sh -c on the local machine. Primary use case is curl + standard Unix utilities (jq, grep, awk, sed, head, sort, uniq) for HTTP testing, file inspection, and bash one-liners. The user will be prompted to approve each command. Capture concise output — pipe through `head` for huge outputs. Do not run interactive commands. Authorized engagements only.',
      'Write portable macOS/BSD + Linux commands. Avoid GNU-only flags such as `grep -P`; prefer `grep -E`, `awk`, `sed`, `perl -ne`, or `jq` for extraction.',
      '',
      'Default to curl for HTTP work; only use specialized scanners (ffuf, nuclei, sqlmap, etc.) when the user explicitly asks for them.',
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute. Will run via /bin/sh -c.',
        },
        timeout_seconds: {
          type: 'integer',
          description: 'Optional timeout in seconds (default 300, max 1800).',
        },
      },
      required: ['command'],
    };
  }

  requiresPermission(): boolean {
    return true;
  }

  // Scope an "allow session" approval to the exact command the user saw.
  // A different command re-prompts, so approving `id` once can't silently
  // license arbitrary later commands for the rest of the session. We do NOT
  // set noSessionCache: re-running the identical command should stay quiet.
  permissionHints(args: Record<string, unknown>): { cacheKey: string } {
    return { cacheKey: rewritePortableCommand(argString(args, 'command')) };
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const cmd = rewritePortableCommand(argString(args, 'command'));
    const firstLine = cmd.split('\n', 1)[0] ?? '';
    const truncated = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
    return { summary: `${this.toolName}: ${truncated}`, detail: cmd };
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, _p: Prompter): Promise<string> {
    const originalCmd = argString(args, 'command');
    const cmdStr = rewritePortableCommand(originalCmd);
    if (!cmdStr) throw new Error('command is required');

    for (const re of DENY_PATTERNS) {
      if (re.test(originalCmd) || re.test(cmdStr)) {
        throw new Error(`command blocked by denylist (matched ${re.source})`);
      }
    }
    for (const { re, message } of PORTABILITY_PATTERNS) {
      if (re.test(cmdStr)) {
        throw new Error(`command blocked for portability: ${message}`);
      }
    }

    const timeoutArg = args.timeout_seconds;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (typeof timeoutArg === 'number' && timeoutArg > 0) {
      timeoutMs = Math.min(timeoutArg * 1000, MAX_TIMEOUT_MS);
    }

    return runWithCapture(this.shellPath, ['-c', cmdStr], timeoutMs, signal);
  }
}

export function rewritePortableCommand(command: string): string {
  return command.replace(
    GREP_P_RE,
    (match, sep: string, lead: string, rawFlags: string, rawPattern: string, rest: string) => {
      const flags = rawFlags.trim().split(/\s+/).filter(Boolean);
      const shortFlags = flags
        .filter((flag) => /^-[A-Za-z]+$/.test(flag))
        .map((flag) => flag.slice(1))
        .join('');
      const hasPerlRegexp = flags.includes('--perl-regexp') || shortFlags.includes('P');
      if (!hasPerlRegexp) return match;

      const unsupportedFlags = shortFlags.replace(/[Piovh]/g, '');
      const hasUnsupportedLong = flags.some(
        (flag) => flag.startsWith('--') && flag !== '--perl-regexp',
      );
      if (unsupportedFlags || hasUnsupportedLong) return match;

      const pattern = unquoteShellToken(rawPattern);
      if (pattern == null) return match;

      const fileArgs = rest.trim();
      // Bail if an option-like token trails the pattern (e.g. `-A3`, `--color`).
      // grep context/format flags have no faithful perl one-liner equivalent;
      // emitting them as bareword perl "filenames" would silently corrupt the
      // command. Leaving the original `grep -P` lets the portability guard
      // surface a clear message instead of producing a broken rewrite.
      if (/(?:^|\s)-/.test(fileArgs)) return match;

      const regexFlags = shortFlags.includes('i') ? 'i' : '';
      const negate = shortFlags.includes('v');
      const extractOnly = shortFlags.includes('o');
      // Pass the user pattern as DATA via the environment, never inlined into
      // the Perl source. A regex built from an interpolated *variable* matches
      // its content as a pattern but does NOT run `@{[...]}` interpolation or
      // `(?{...})` code blocks (those require a literal regex / `use re 'eval'`),
      // so the portability rewrite can't become a code-execution primitive.
      const prelude = 'BEGIN { $p = $ENV{PF_GREP_PAT} } ';
      const code = extractOnly
        ? `${prelude}while (/$p/${regexFlags}g) { print "$&\\n" }`
        : negate
          ? `${prelude}print unless /$p/${regexFlags}`
          : `${prelude}print if /$p/${regexFlags}`;
      const perl = `PF_GREP_PAT=${shellQuote(pattern)} perl -ne ${shellQuote(code)}`;
      return `${sep}${lead}${perl}${fileArgs ? ` ${fileArgs}` : ''}`;
    },
  );
}

function unquoteShellToken(token: string): string | null {
  if (!token) return null;
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return token.replace(/\\(.)/g, '$1');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** BashTool is a PascalCase alias for ShellTool that uses /bin/bash. */
export class BashTool extends ShellTool {
  constructor() {
    super('/bin/bash', 'BashTool');
  }

  override description(): string {
    return "Run a bash command via /bin/bash -c on the local machine. Same gating as the shell tool (per-command permission, denylist, output truncation). Prefer this over `shell` when you need bash features like [[ ]] tests, process substitution <(...), arrays, or $'...' quoting.";
  }
}

function runWithCapture(
  cmd: string,
  argv: string[],
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<string> {
  return new Promise((resolveOut) => {
    const controller = new AbortController();
    let childPid = 0;
    const onParentAbort = () => {
      killProcessGroup(childPid);
      controller.abort();
    };
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(childPid);
      controller.abort();
    }, timeoutMs);
    let timedOut = false;
    timer.unref?.();

    const child = spawn(cmd, argv, { detached: true, signal: controller.signal });
    childPid = child.pid ?? 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    // Track every byte received (even bytes we stop retaining past the cap)
    // so the truncation marker is deterministic regardless of chunk sizes.
    let stdoutTotal = 0;
    let stderrTotal = 0;

    // Only the first MAX_OUTPUT_BYTES of each stream are ever shown, so we
    // stop *retaining* bytes past that point. Without this, a command like
    // `yes` or `cat /dev/zero` would grow these buffers until the process
    // OOMs — the truncate() at close caps what the model sees, not memory.
    // We keep consuming (and discarding) data so the child isn't blocked on
    // backpressure; the timeout still bounds total runtime.
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
        resolveOut(
          `exit: timeout after ${timeoutMs / 1000}s\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
        return;
      }

      const exitCode = code ?? (sig ? 128 + signalToInt(sig) : 0);
      let result = `exit: ${exitCode}\nstdout:\n${stdout}`;
      if (stderr) result += `\nstderr:\n${stderr}`;
      resolveOut(result);
    });

    child.on('error', (err) => {
      if (controller.signal.aborted && err.name === 'AbortError') return;
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
      const stdout = truncate(Buffer.concat(stdoutChunks).toString('utf8'), stdoutTotal);
      const stderr = truncate(Buffer.concat(stderrChunks).toString('utf8'), stderrTotal);
      resolveOut(`exit: -1\nstdout:\n${stdout}\nstderr:\n${stderr}\nerror: ${err.message}`);
    });
  });
}

function killProcessGroup(pid: number): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function truncate(s: string, total?: number): string {
  const seen = total ?? s.length;
  if (seen <= MAX_OUTPUT_BYTES) return s;
  return `${s.slice(0, MAX_OUTPUT_BYTES)}\n[... truncated ${seen - MAX_OUTPUT_BYTES} bytes ...]`;
}

function signalToInt(sig: NodeJS.Signals): number {
  // Best-effort mapping for the most common signals so the exit code is
  // still meaningful in the tool output.
  switch (sig) {
    case 'SIGINT':
      return 2;
    case 'SIGKILL':
      return 9;
    case 'SIGTERM':
      return 15;
    default:
      return 1;
  }
}
