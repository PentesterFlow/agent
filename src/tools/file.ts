// File read / write / edit tools. Reads of paths on the sensitive-path
// denylist require an explicit user prompt; other reads go through
// frictionless. Writes and edits always require permission (handled by
// the registry).

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Prompter } from '../permission/permission.js';
import { isSensitivePath } from './sensitive.js';
import { type Tool, argBool, argString } from './types.js';

const READ_BYTE_CAP = 200 * 1024;

/**
 * Decode up to `cap` bytes of UTF-8 without emitting a trailing U+FFFD when the
 * cap falls mid-codepoint. StringDecoder.write returns only the complete
 * characters and holds back an incomplete trailing sequence, which we drop by
 * never calling end(). Used by the read/mention byte caps.
 */
export function decodeUtf8Capped(buf: Buffer, cap: number): string {
  return new StringDecoder('utf8').write(buf.subarray(0, cap));
}

/**
 * Resolve a path to its real on-disk location so a symlink (e.g.
 * ./notes -> ~/.ssh/id_rsa) can't smuggle a credential file past the
 * sensitive-path gate. `resolve()` only normalizes `..`; it does NOT
 * follow links. For a not-yet-existing target (write/edit of a new file)
 * we realpath the parent directory instead, so a symlinked parent dir is
 * also caught. Falls back to the lexical path if nothing on disk resolves.
 */
async function realResolve(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    try {
      return resolve(await realpath(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * Prompt before touching a sensitive path. The path is sensitive if EITHER
 * the lexical path or its symlink-resolved real path matches the denylist:
 * checking the lexical path keeps listed entries like /etc/shadow matching
 * even where realpath would canonicalize them (e.g. /private/etc on macOS),
 * while checking the real path defeats symlink smuggling. Flagged
 * noSessionCache so the prompt fires on every access and is never silently
 * re-granted for the session. (Under YOLO, like every gate, it's
 * auto-approved.) `verb` is "read"/"write to"/"edit".
 *
 * Returns the symlink-resolved real path; callers MUST perform their actual
 * read/write on this returned path rather than re-resolving the lexical one.
 * Reading/writing the already-resolved path (which contains no symlinks at the
 * leaf) closes the TOCTOU window where a symlink swapped between the gate check
 * and the I/O could smuggle a credential file past the prompt. Throws on deny.
 */
export async function gateSensitivePath(
  p: Prompter,
  abs: string,
  verb: string,
  signal: AbortSignal,
): Promise<string> {
  const real = await realResolve(abs);
  if (!isSensitivePath(abs) && !isSensitivePath(real)) return real;
  const shown = real !== abs ? `${abs}\nresolves to: ${real}` : abs;
  const decision = await p.ask(
    {
      tool: 'file',
      summary: `${verb} sensitive file: ${real}`,
      detail: `path: ${shown}\n\nThis path is on the sensitive-path list (private keys, cloud credentials, shell history, config dirs, etc.). Approve only if you intend to ${verb} it.`,
      noSessionCache: true,
    },
    signal,
  );
  if (decision === 'deny') {
    throw new Error(`${verb} of sensitive path denied: ${real}`);
  }
  return real;
}

export class FileReadTool implements Tool {
  private readonly toolName: string;
  constructor(toolName = 'file_read') {
    this.toolName = toolName;
  }
  name(): string {
    return this.toolName;
  }
  description(): string {
    return 'Read a UTF-8 file from disk. Use for inspecting recon output, wordlists, notes, exploit code. Returns up to 200KB; use shell+head for larger files. Reads of paths under ~/.ssh, ~/.aws, shell history files, etc. require explicit user approval.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to file.' },
      },
      required: ['path'],
    };
  }
  /** Sensitive paths are gated inline in run(); ordinary reads are frictionless. */
  requiresPermission(): boolean {
    return false;
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const path = argString(args, 'path');
    if (!path) throw new Error('path is required');
    const abs = resolve(path);

    // Read from the gate-resolved real path, not the lexical one (M1 TOCTOU).
    const real = await gateSensitivePath(p, abs, 'read', signal);

    const buf = await readFile(real);
    if (buf.byteLength > READ_BYTE_CAP) {
      const head = decodeUtf8Capped(buf, READ_BYTE_CAP);
      return `${head}\n[... truncated ${buf.byteLength - READ_BYTE_CAP} bytes ...]`;
    }
    return buf.toString('utf8');
  }
}

export class FileWriteTool implements Tool {
  private readonly toolName: string;
  constructor(toolName = 'file_write') {
    this.toolName = toolName;
  }
  name(): string {
    return this.toolName;
  }
  description(): string {
    return 'Write content to a file, creating or overwriting it. Use for saving notes, PoC scripts, recon output. User confirmation required.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination file path.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    };
  }
  requiresPermission(): boolean {
    return true;
  }
  // Scope an "allow session" approval to the destination path so it can't
  // silently authorize writes to other files for the rest of the session.
  permissionHints(args: Record<string, unknown>): { cacheKey: string } {
    return { cacheKey: resolve(argString(args, 'path')) };
  }
  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const path = argString(args, 'path');
    const content = argString(args, 'content');
    const preview = content.length > 400 ? `${content.slice(0, 400)}...` : content;
    return {
      summary: `write file: ${path}`,
      detail: `path: ${path}\n--- content ---\n${preview}`,
    };
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const path = argString(args, 'path');
    const content = argString(args, 'content');
    if (!path) throw new Error('path is required');
    const abs = resolve(path);
    const real = await gateSensitivePath(p, abs, 'write to', signal);
    await mkdir(dirname(real), { recursive: true, mode: 0o755 });
    await writeFile(real, content, { encoding: 'utf8', mode: 0o644 });
    return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${real}`;
  }
}

export class FileEditTool implements Tool {
  private readonly toolName: string;
  constructor(toolName = 'file_edit') {
    this.toolName = toolName;
  }
  name(): string {
    return this.toolName;
  }
  description(): string {
    return 'Replace an exact string in a file. old_string must appear exactly once unless replace_all=true. Use for patching scripts or notes without rewriting the whole file.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    };
  }
  requiresPermission(): boolean {
    return true;
  }
  // Scope an "allow session" approval to the edited path (see FileWriteTool).
  permissionHints(args: Record<string, unknown>): { cacheKey: string } {
    return { cacheKey: resolve(argString(args, 'path')) };
  }
  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const path = argString(args, 'path');
    return {
      summary: `edit file: ${path}`,
      detail: `path: ${path}\n- ${argString(args, 'old_string')}\n+ ${argString(args, 'new_string')}`,
    };
  }

  async run(args: Record<string, unknown>, signal: AbortSignal, p: Prompter): Promise<string> {
    const path = argString(args, 'path');
    const oldS = argString(args, 'old_string');
    const newS = argString(args, 'new_string');
    const replaceAll = argBool(args, 'replace_all');
    if (!path || !oldS) throw new Error('path and old_string are required');

    const abs = resolve(path);
    const real = await gateSensitivePath(p, abs, 'edit', signal);
    const content = await readFile(real, 'utf8');
    const count = countOccurrences(content, oldS);
    if (count === 0) throw new Error(`old_string not found in ${real}`);
    if (count > 1 && !replaceAll) {
      throw new Error(
        `old_string appears ${count} times in ${real}; pass replace_all=true or use a longer unique snippet`,
      );
    }
    // Always split/join (literal replacement). String.prototype.replace would
    // interpret `$&`/`$1`/`$$`/`` $` `` in new_string, silently corrupting PoCs
    // or scripts that contain those literally (L3). With count===1 in the
    // single branch, split/join replaces exactly that one occurrence.
    const updated = content.split(oldS).join(newS);
    await writeFile(real, updated, { encoding: 'utf8', mode: 0o644 });
    return `edited ${real} (${count} replacement(s))`;
  }
}

/** PascalCase tool-name aliases. Same behavior, different tool name surface
 *  so prompts written for either convention work without translation. */
export class FileReadToolAlias extends FileReadTool {
  constructor() {
    super('FileReadTool');
  }
}
export class FileWriteToolAlias extends FileWriteTool {
  constructor() {
    super('FileWriteTool');
  }
}
export class FileEditToolAlias extends FileEditTool {
  constructor() {
    super('FileEditTool');
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) return count;
    count += 1;
    pos = idx + needle.length;
  }
}

// Re-exported so callers don't have to import node:path just to check.
export { isAbsolute };
