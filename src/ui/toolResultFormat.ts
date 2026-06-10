// Colorize the body of a tool-result for the transcript. The split:
// exit code stands out (green
// when 0, red otherwise), stdout / stderr labels are dim so they don't
// fight the actual output, and stderr content is tinted red. Plain
// text passes through unchanged so non-shell tools (file_read,
// confirm_finding) keep their format intact.

import { Chalk } from 'chalk';
import { highlight } from 'cli-highlight';
import { chalkLevel } from './colorLevel.js';

const chalk = new Chalk({ level: chalkLevel() });

const EXIT_RE = /^exit:\s*(-?\d+|timeout[^\n]*)/;
const STDOUT_LABEL = 'stdout:';
const STDERR_LABEL = 'stderr:';

interface ShellResultParts {
  exit: string;
  stdout: string;
  stderr: string;
  rest: string;
}

/**
 * Return `body` styled for the transcript. Recognises the shape that
 * ShellTool / BashTool produce:
 *
 *   exit: 0
 *   stdout:
 *   <captured stdout>
 *   stderr:
 *   <captured stderr>
 *
 * Lines outside the recognised structure pass through unchanged.
 */
export function colorizeShellResult(body: string): string {
  if (!body) return body;
  const lines = body.split('\n');
  let section: 'pre' | 'stdout' | 'stderr' = 'pre';
  return lines
    .map((line) => {
      const exitMatch = line.match(EXIT_RE);
      if (exitMatch) {
        const tail = line.slice(exitMatch[0].length);
        const code = exitMatch[1] ?? '';
        const isSuccess = code === '0';
        const isTimeout = code.startsWith('timeout');
        const styledCode = isSuccess
          ? chalk.green(code)
          : isTimeout
            ? chalk.yellow(code)
            : chalk.red(code);
        return `${chalk.dim('exit:')} ${styledCode}${tail}`;
      }
      if (line === STDOUT_LABEL) {
        section = 'stdout';
        return chalk.dim(STDOUT_LABEL);
      }
      if (line === STDERR_LABEL) {
        section = 'stderr';
        return chalk.dim(STDERR_LABEL);
      }
      // stderr section gets a subtle red tint so the eye spots warnings
      // / errors without re-reading. stdout passes through verbatim.
      if (section === 'stderr' && line) return chalk.red(line);
      return line;
    })
    .join('\n');
}

/**
 * Detect whether a tool-result body looks like the structured shell
 * output (exit:/stdout:/stderr: shape) — used by state.ts to decide
 * whether to run it through colorizeShellResult vs leave it plain.
 */
export function looksLikeShellResult(body: string): boolean {
  return EXIT_RE.test(body) || body.startsWith(STDOUT_LABEL) || body.includes('\nstdout:');
}

function parseShellResult(body: string): ShellResultParts | null {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  const first = lines[0] ?? '';
  const exitMatch = first.match(EXIT_RE);
  if (!exitMatch) return null;

  const stdoutIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === STDOUT_LABEL);
  if (stdoutIdx === -1) return null;

  const stderrIdx = lines.findIndex((line, idx) => idx > stdoutIdx && line.trim() === STDERR_LABEL);
  const stdoutLines =
    stderrIdx === -1 ? lines.slice(stdoutIdx + 1) : lines.slice(stdoutIdx + 1, stderrIdx);
  const stderrLines = stderrIdx === -1 ? [] : lines.slice(stderrIdx + 1);

  return {
    exit: exitMatch[1] ?? '',
    stdout: trimTrailingBlankLines(stdoutLines).join('\n'),
    stderr: trimTrailingBlankLines(stderrLines).join('\n'),
    rest: lines.slice(1, stdoutIdx).join('\n'),
  };
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function compactShellResultForTranscript(body: string): string {
  const parsed = parseShellResult(body);
  if (parsed && parsed.exit !== '0' && !parsed.stderr && !parsed.rest && !parsed.stdout) {
    return `exit: ${parsed.exit}\n(no output)`;
  }
  if (parsed && parsed.exit !== '0' && parsed.stderr && !parsed.rest && !parsed.stdout) {
    return `exit: ${parsed.exit}\nstderr:\n${parsed.stderr}`;
  }
  if (
    !parsed ||
    parsed.exit !== '0' ||
    parsed.stderr ||
    parsed.rest ||
    !parsed.stdout ||
    parsed.stdout.includes('\n[... truncated ')
  ) {
    return body;
  }
  return parsed.stdout;
}

export function shellResultExitStatus(body: string): string | null {
  return parseShellResult(body)?.exit ?? null;
}

// ---------------------------------------------------------------------------
// HTTP-response coloring — the http tool emits `HTTP/1.1 <status> <text>`, a
// header block, a blank line, then the body. Color the status line by class
// (2xx green, 3xx cyan, 4xx yellow, 5xx red), dim header names, and best-
// effort syntax-highlight a JSON body. Coloring never changes line counts
// (no reflow), so the collapse accounting in buildToolResultView stays valid.
// ---------------------------------------------------------------------------

const HTTP_STATUS_RE = /^(HTTP\/[\d.]+)\s+(\d{3})\s*(.*)$/;

/** True when a tool-result body looks like an http-tool HTTP response. */
export function looksLikeHTTPResult(body: string): boolean {
  return HTTP_STATUS_RE.test(body.split('\n', 1)[0] ?? '');
}

function statusColor(code: number): (s: string) => string {
  if (code >= 200 && code < 300) return (s) => chalk.green(s);
  if (code >= 300 && code < 400) return (s) => chalk.cyan(s);
  if (code >= 400 && code < 500) return (s) => chalk.yellow(s);
  if (code >= 500) return (s) => chalk.red(s);
  return (s) => s;
}

function colorizeHeaderLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx <= 0) return line;
  return `${chalk.dim(line.slice(0, idx + 1))}${line.slice(idx + 1)}`;
}

function maybeHighlightJSON(bodyText: string): string {
  const trimmed = bodyText.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return bodyText;
  try {
    return highlight(bodyText, { language: 'json', ignoreIllegals: true });
  } catch {
    return bodyText;
  }
}

export function colorizeHTTPResult(body: string): string {
  const lines = body.split('\n');
  const statusMatch = lines[0]?.match(HTTP_STATUS_RE);
  if (!statusMatch) return body;

  const code = Number.parseInt(statusMatch[2] ?? '', 10);
  const color = statusColor(code);
  const statusText = `${statusMatch[2]} ${statusMatch[3] ?? ''}`.trimEnd();
  const statusLine = `${chalk.dim(statusMatch[1] ?? '')} ${color(chalk.bold(statusText))}`;

  // Headers run until the first blank line; everything after it is the body.
  const blankIdx = lines.indexOf('', 1);
  const headerEnd = blankIdx === -1 ? lines.length : blankIdx;
  const out = [statusLine, ...lines.slice(1, headerEnd).map(colorizeHeaderLine)];
  if (blankIdx !== -1) {
    out.push('');
    out.push(maybeHighlightJSON(lines.slice(blankIdx + 1).join('\n')));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Smart tool-result view — extract readable text, then collapse anything long
// behind a head preview the user can expand with Ctrl-O. Keeps the transcript
// scannable when a single MCP call (e.g. a browser accessibility snapshot)
// returns kilobytes of YAML.
// ---------------------------------------------------------------------------

/** Lines of the body kept visible while collapsed. */
const HEAD_LINES = 12;
/** Hard char ceiling on the collapsed preview (guards one huge single line). */
const PREVIEW_CHAR_CAP = 1000;
/** A body longer than either threshold becomes collapsible. */
const COLLAPSE_LINE_THRESHOLD = 16;
const COLLAPSE_CHAR_THRESHOLD = 1200;

export interface ToolResultView {
  /** Full body, styled — shown when expanded. */
  full: string;
  /** Head-only body + "N more lines" notice — shown when collapsed. */
  preview: string;
  /** True when full !== preview, i.e. there is hidden content to expand. */
  collapsible: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * MCP tools hand back a `content` array of typed blocks, which mcp.ts
 * serializes as `JSON.stringify(content, null, 2)`. For the common
 * all-text case (browser snapshots, page text, command output) that means
 * the transcript shows a JSON envelope with the real text buried inside as
 * an escaped `\n`-laden string. Pull the text back out so it renders as
 * actual lines. Anything that isn't a clean array of `{type:'text', text}`
 * blocks (images, mixed content, non-JSON) passes through untouched.
 */
export function extractTextContent(raw: string): string {
  const head = raw.trimStart();
  if (!head.startsWith('[') && !head.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    if (
      blocks.length > 0 &&
      blocks.every((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    ) {
      return blocks.map((b) => (b as { text: string }).text).join('\n');
    }
  } catch {
    // Not JSON — fall through to the raw string.
  }
  return raw;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the collapsed/expanded views for a raw tool-result string. Text is
 * extracted from MCP envelopes first; shell-shaped output is colorized in
 * both views. Short results return `collapsible: false` with preview === full.
 */
export function buildToolResultView(raw: string): ToolResultView {
  const content = compactShellResultForTranscript(extractTextContent(raw));
  const colorize: (s: string) => string = looksLikeShellResult(content)
    ? colorizeShellResult
    : looksLikeHTTPResult(content)
      ? colorizeHTTPResult
      : (s) => s;

  const full = colorize(content);
  const lines = content.split('\n');
  const collapsible =
    lines.length > COLLAPSE_LINE_THRESHOLD || content.length > COLLAPSE_CHAR_THRESHOLD;
  if (!collapsible) return { full, preview: full, collapsible: false };

  let headStr = lines.slice(0, HEAD_LINES).join('\n');
  if (headStr.length > PREVIEW_CHAR_CAP) headStr = headStr.slice(0, PREVIEW_CHAR_CAP);
  const shownLines = headStr.split('\n').length;
  const hiddenLines = Math.max(0, lines.length - shownLines);
  const what =
    hiddenLines > 0 ? `${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}` : 'more output';
  const notice = chalk.dim(`… ${what} · ${formatBytes(content.length)} — Ctrl-O to expand`);
  return { full, preview: `${colorize(headStr)}\n${notice}`, collapsible: true };
}
