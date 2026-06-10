// Inline markdown → ANSI renderer for the transcript. Deliberately
// regex-based rather than a full markdown parser: assistant output is
// usually a paragraph or two with the occasional **bold**, `code`, or
// `# Heading`, and a real parser is overkill for that. Ink renders ANSI
// escape codes inside <Text> verbatim, so the returned string drops
// straight into the transcript without any further wrapping.
//
// Supported syntax:
//   **bold**          →  bold
//   __bold__          →  bold
//   *italic*          →  italic   (single-word; *foo bar* also OK)
//   _italic_          →  italic
//   `inline code`     →  cyan
//   # Heading         →  bold magenta (line-level)
//   ## Heading        →  bold cyan
//   ###+ Heading      →  bold (no color)
//   - list item       →  • prefix
//   * list item       →  • prefix
//   ``` … ```         →  code block, language-aware syntax highlighting
//                       when the fence specifies a language (e.g. ```bash);
//                       dim plain text otherwise. No inline markdown is
//                       re-applied inside the fences.
//   <proposed_plan>   →  hidden wrapper tag; content remains visible.

import { Chalk } from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import { chalkLevel } from './colorLevel.js';

// Force color level 3 (truecolor) inside this module. Default chalk
// suppresses ANSI when stdout isn't a TTY (test runs, piped output),
// but the transcript is always rendered by Ink — Ink requires a TTY
// itself — so always emitting ANSI is correct and lets tests assert
// directly on the escape sequences without test-env overrides. Drops to
// level 0 when NO_COLOR is set (see colorLevel.ts).
const chalk = new Chalk({ level: chalkLevel() });

/**
 * Render a markdown string to an ANSI-styled string for direct insertion
 * into an Ink <Text> child. Safe to call on plain text — returns the
 * input unchanged when no markdown syntax is present.
 */
export function renderMarkdown(s: string): string {
  if (!s) return s;
  const lines = stripProposedPlanWrapper(s).split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  let fenceBuf: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    // CommonMark allows 0-3 spaces of indent before a fence marker. We
    // honor that — many models emit ` ```python` (one space) when the
    // block sits after a colon or inside a list, and a strict
    // startsWith('```') silently dropped those.
    const fenceMatch = raw.match(/^[ \t]{0,3}```\s*(\S*)/);
    if (fenceMatch) {
      if (inFence) {
        // Closing fence — flush buffered content. renderFencedBlock
        // now returns the WHOLE block (header rule + gutter body +
        // footer rule), so we don't push our own ``` markers.
        out.push(renderFencedBlock(fenceBuf, fenceLang));
        inFence = false;
        fenceLang = '';
        fenceBuf = [];
      } else {
        // Opening fence — record language, don't emit anything yet.
        // The header rule is drawn by renderFencedBlock once we know
        // the body width.
        inFence = true;
        fenceLang = fenceMatch[1] ?? '';
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(raw);
      continue;
    }
    // GitHub-style pipe table: a header row followed by a |---|---| separator.
    // Consume the whole block and render it box-aligned.
    if (isTableRow(raw) && isTableSeparator(lines[i + 1] ?? '')) {
      const block: string[] = [raw];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j] ?? '')) {
        block.push(lines[j] ?? '');
        j += 1;
      }
      out.push(renderTable(block));
      i = j - 1;
      continue;
    }
    out.push(renderLine(raw));
  }

  // Unterminated fence: render whatever we buffered so the user still
  // gets something readable instead of silently losing the tail.
  if (inFence && fenceBuf.length > 0) {
    out.push(renderFencedBlock(fenceBuf, fenceLang));
  }

  return out.join('\n');
}

function stripProposedPlanWrapper(s: string): string {
  const lines = s.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '<proposed_plan>' && trimmed !== '</proposed_plan>';
  });
  return trimOuterBlankLines(lines).join('\n');
}

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(start, end);
}

/**
 * Render a buffered code block. Minimal chrome: syntax-highlighted
 * body + `NN│ ` line-number gutter. No header rule, no language chip,
 * no footer rule — those felt like section dividers, not code
 * containers. Fenced code renders as bare
 * highlighted text (no chrome at all); we keep the gutter on top of
 * that because line numbers are the actually-useful affordance for
 * pentest workflows (referencing payload line 3 by number, etc.).
 *
 * Result for hello world:
 *
 *   1│ print("Hello, World!")
 *
 * Result for a 5-line bash block:
 *
 *   1│ #!/usr/bin/env bash
 *   2│ set -euo pipefail
 *   3│ NAME="World"
 *   4│ echo "Hello, ${NAME}!"
 *   5│ curl -s -o /dev/null -w "%{http_code}\n" "$URL"
 *
 * The `│` glyph on every row IS the visual separation from prose —
 * no extra horizontal rule needed.
 */
function renderFencedBlock(lines: string[], lang: string): string {
  if (lines.length === 0) return '';

  let highlighted: string[];
  if (lang && supportsLanguage(lang)) {
    try {
      // cli-highlight returns the whole body with ANSI in place; split
      // back into rows so we can add the gutter line-by-line.
      highlighted = highlight(lines.join('\n'), {
        language: lang,
        ignoreIllegals: true,
      }).split('\n');
    } catch {
      highlighted = lines.map((l) => chalk.dim(l));
    }
  } else {
    highlighted = lines.map((l) => chalk.dim(l));
  }

  const gutterWidth = String(highlighted.length).length;
  return highlighted
    .map((row, i) => {
      const num = String(i + 1).padStart(gutterWidth, ' ');
      return `${chalk.dim(`${num}│`)} ${row}`;
    })
    .join('\n');
}

function renderLine(line: string): string {
  // Heading: # / ## / ### Heading
  const heading = line.match(/^(\s*)(#{1,6})\s+(.*)$/);
  if (heading) {
    const indent = heading[1] ?? '';
    const level = (heading[2] ?? '').length;
    const text = renderInline(heading[3] ?? '');
    if (level === 1) return `${indent}${chalk.bold(chalk.magenta(text))}`;
    if (level === 2) return `${indent}${chalk.bold(chalk.cyan(text))}`;
    return `${indent}${chalk.bold(text)}`;
  }

  // Bullet: `- item` or `* item` (the bullet marker is rewritten to a
  // bullet glyph). Numbered lists pass through unchanged.
  const bullet = line.match(/^(\s*)([-*])\s+(.*)$/);
  if (bullet) {
    const indent = bullet[1] ?? '';
    return `${indent}${chalk.gray('•')} ${renderInline(bullet[3] ?? '')}`;
  }

  // Blockquote: `> text`
  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    const indent = quote[1] ?? '';
    return `${indent}${chalk.gray('│ ')}${chalk.dim(renderInline(quote[2] ?? ''))}`;
  }

  return renderInline(line);
}

/** Inline span styling. Order matters — links are processed first so their
 *  URLs aren't mangled by the emphasis passes, then code (so backtick
 *  contents aren't re-interpreted as bold/italic), then bold/italic. */
function renderInline(s: string): string {
  if (!s) return s;
  return s
    .replace(LINK_RE, (_m, label: string, url: string) =>
      label === url
        ? chalk.blue.underline(url)
        : `${chalk.blue.underline(label)} ${chalk.dim(`(${url})`)}`,
    )
    .replace(/`([^`]+)`/g, (_m, body: string) => chalk.cyan(body))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => chalk.bold(body))
    .replace(/__([^_\n]+)__/g, (_m, body: string) => chalk.bold(body))
    .replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, (_m, body: string) => chalk.italic(body))
    .replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, (_m, body: string) => chalk.italic(body));
}

// [label](url) — url stops at whitespace or the closing paren so trailing
// prose isn't swallowed. Bare/auto links are left untouched.
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

// ---------- tables ----------

// Match SGR color escapes (ESC [ … m). Built via fromCharCode so the source
// holds no literal control character (which the linter forbids).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Visible width of a string after ANSI escapes are stripped. */
function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** A line that participates in a pipe table (contains a `|`). */
function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

/** The `|---|:--:|` divider under a table header. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

/** Split a pipe row into trimmed cells, dropping the optional leading/
 *  trailing pipe. A `\|` escapes a literal pipe inside a cell. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/**
 * Render a markdown pipe table as an aligned, box-drawn grid. `block[0]` is
 * the header, `block[1]` was the separator (already consumed by the caller —
 * not passed in here), `block[1..]` are body rows. Columns are sized to the
 * widest rendered cell; a `─┼─` rule separates the header from the body.
 */
function renderTable(block: string[]): string {
  const header = splitTableRow(block[0] ?? '');
  const bodyRows = block.slice(1).map(splitTableRow);
  const cols = Math.max(header.length, ...bodyRows.map((r) => r.length), 1);

  const cell = (cells: string[], c: number): string => renderInline(cells[c] ?? '');
  const widths: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    let w = visibleWidth(cell(header, c));
    for (const row of bodyRows) w = Math.max(w, visibleWidth(cell(row, c)));
    widths[c] = w;
  }

  const pad = (text: string, width: number): string =>
    text + ' '.repeat(Math.max(0, width - visibleWidth(text)));

  const renderRow = (cells: string[], bold: boolean): string => {
    const parts: string[] = [];
    for (let c = 0; c < cols; c += 1) {
      const styled = bold ? chalk.bold(cell(cells, c)) : cell(cells, c);
      parts.push(pad(styled, widths[c] ?? 0));
    }
    return parts.join(chalk.dim(' │ '));
  };

  // Mirror the ` │ ` column join with `─┼─` so the ┼ sits under each │.
  const rule = widths.map((w) => '─'.repeat(w ?? 0)).join('─┼─');
  const out = [renderRow(header, true), chalk.dim(rule)];
  for (const row of bodyRows) out.push(renderRow(row, false));
  return out.join('\n');
}
