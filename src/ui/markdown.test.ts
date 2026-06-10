// Markdown renderer tests. ANSI escape sequences are checked literally
// so a regression that drops a style wrapper is caught (`\x1b[1m...\x1b[22m`
// is the chalk bold envelope; matching just the visible-text portion via
// strip-ansi would let silent drops through).

import { beforeAll, describe, expect, it, vi } from 'vitest';

let renderMarkdown: typeof import('./markdown.js').renderMarkdown;

beforeAll(async () => {
  vi.stubEnv('NO_COLOR', '');
  ({ renderMarkdown } = await import('./markdown.js'));
});

// ESC is 0x1B; build the strip regex from a char-code so Biome's
// no-control-characters-in-regex rule doesn't reject the literal.
const ESC = String.fromCharCode(0x1b);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const BOLD = `${ESC}[1m`;
const ITALIC = `${ESC}[3m`;
const CYAN = `${ESC}[36m`;

describe('renderMarkdown', () => {
  it('returns input unchanged when no markdown syntax is present', () => {
    const plain = 'hello world, nothing fancy here';
    expect(renderMarkdown(plain)).toBe(plain);
  });

  it('renders **bold**', () => {
    const out = renderMarkdown('confirmed **IDOR** in /api');
    expect(out).toContain(BOLD);
    expect(out).toContain('IDOR');
    expect(stripAnsi(out)).toBe('confirmed IDOR in /api');
  });

  it('renders __bold__ alt syntax', () => {
    const out = renderMarkdown('this is __also bold__');
    expect(out).toContain(BOLD);
    expect(stripAnsi(out)).toBe('this is also bold');
  });

  it('renders *italic* and _italic_', () => {
    expect(renderMarkdown('makes *italics*')).toContain(ITALIC);
    expect(renderMarkdown('makes _italics_')).toContain(ITALIC);
  });

  it('does NOT treat * inside words as italic (avoids breaking auth_token, foo*bar*baz)', () => {
    // The * here is mid-word — should pass through.
    expect(stripAnsi(renderMarkdown('foo*bar*baz'))).toBe('foo*bar*baz');
    expect(stripAnsi(renderMarkdown('snake_case_token'))).toBe('snake_case_token');
  });

  it('renders `inline code`', () => {
    const out = renderMarkdown('hit `/api/users/1` to repro');
    expect(out).toContain('/api/users/1');
    expect(out).toContain(CYAN);
  });

  it('renders # heading as bold', () => {
    const out = renderMarkdown('# Findings\nbody');
    expect(out.split('\n')[0]).toContain(BOLD);
    expect(stripAnsi(out)).toBe('Findings\nbody');
  });

  it('renders ## subheading as bold', () => {
    const out = renderMarkdown('## Recon\nbody');
    expect(out.split('\n')[0]).toContain(BOLD);
  });

  it('rewrites bullet markers to •', () => {
    const out = renderMarkdown('- one\n- two');
    expect(stripAnsi(out)).toBe('• one\n• two');
  });

  it('preserves indentation on bullets', () => {
    const out = renderMarkdown('  - nested');
    expect(stripAnsi(out)).toBe('  • nested');
  });

  it('renders blockquote with vertical bar prefix', () => {
    const out = renderMarkdown('> heads up');
    expect(stripAnsi(out)).toBe('│ heads up');
  });

  it('preserves code-fence content verbatim, no inline markdown inside', () => {
    const input = '```\n**not bold here** plain text\n```';
    const out = renderMarkdown(input);
    // Stripped, the body still contains the literal stars (not consumed
    // by inline bold) because we're inside a fence.
    expect(stripAnsi(out)).toContain('**not bold here**');
  });

  it('syntax-highlights a fenced bash block', () => {
    const input = '```bash\ncurl -s https://example.com | jq .\n```';
    const out = renderMarkdown(input);
    // Output should carry several ANSI sequences (highlighter colored
    // multiple tokens) and the visible text should still match source.
    const ansiCount = (out.match(new RegExp(`${ESC}\\[`, 'g')) ?? []).length;
    expect(ansiCount).toBeGreaterThan(1);
    expect(stripAnsi(out)).toContain('curl');
    expect(stripAnsi(out)).toContain('https://example.com');
  });

  it('syntax-highlights a fenced python block', () => {
    const input = '```python\nimport socket\nsocket.gethostbyname("x")\n```';
    const out = renderMarkdown(input);
    expect(stripAnsi(out)).toContain('import socket');
    expect(stripAnsi(out)).toContain('gethostbyname');
  });

  it('falls back to dim rendering for unknown languages', () => {
    const input = '```madeup-lang-9999\nplain content\n```';
    const out = renderMarkdown(input);
    expect(stripAnsi(out)).toContain('plain content');
    // Still wrapped in ANSI (dim) so the block reads as code.
    expect(out).toContain(ESC);
  });

  it('handles unterminated code fences gracefully', () => {
    const input = '```bash\necho still flushed even without closing fence';
    const out = renderMarkdown(input);
    expect(stripAnsi(out)).toContain('echo still flushed even without closing fence');
  });

  it('adds a line-number gutter to multi-line code blocks', () => {
    const lines = ['ls', 'pwd', 'whoami', 'uname -a', 'id'];
    const input = `\`\`\`bash\n${lines.join('\n')}\n\`\`\``;
    const out = renderMarkdown(input);
    const stripped = stripAnsi(out);
    expect(stripped).toContain('1│');
    expect(stripped).toContain('5│');
    for (const l of lines) expect(stripped).toContain(l);
  });

  it('numbers every fenced block, including single-line snippets', () => {
    const input = '```python\nprint("Hello, World!")\n```';
    const stripped = stripAnsi(renderMarkdown(input));
    expect(stripped).toContain('1│');
    expect(stripped).toContain('print("Hello, World!")');
  });

  it('accepts up to 3 leading spaces before the fence marker (CommonMark)', () => {
    // ` ```python` (one space) — common when the block follows a colon
    // or sits inside a bullet list. The old strict startsWith('```')
    // silently dropped these so the literal backticks ended up in the
    // transcript. After the CommonMark relaxation the fence is parsed
    // → gutter row + header/footer rules appear, no literal ``` in
    // the body.
    const input = ' ```python\nprint("hi")\n ```';
    const out = renderMarkdown(input);
    const stripped = stripAnsi(out);
    expect(stripped).toContain('1│'); // gutter ran → fence parsed
    expect(stripped).toContain('print("hi")');
    // No literal triple-backticks should remain — we replaced them
    // with horizontal rules.
    expect(stripped).not.toContain('```');
  });

  it('renders fenced blocks as bare gutter + body (no header chip, no rules)', () => {
    const input = '```python\nprint("Hello, World!")\n```';
    const stripped = stripAnsi(renderMarkdown(input));
    // No language chip, no horizontal rules.
    expect(stripped).not.toContain('─── python');
    expect(stripped).not.toMatch(/^─+$/m);
    // No literal markdown backticks left in the output.
    expect(stripped).not.toContain('```');
    // Just the gutter row.
    expect(stripped).toContain('1│ print("Hello, World!")');
  });

  it('emits nothing for an empty fenced block', () => {
    expect(renderMarkdown('```\n```')).toBe('');
  });

  it('accepts a tab-indented fence', () => {
    const input = '\t```bash\necho hi\n\t```';
    expect(stripAnsi(renderMarkdown(input))).toContain('1│');
  });

  it('handles bold inside a heading', () => {
    const out = renderMarkdown('# Title with **bold** word');
    expect(stripAnsi(out)).toBe('Title with bold word');
  });

  it('does not eat code inside bold (code processed first)', () => {
    const out = renderMarkdown('**inline `code` mix**');
    expect(stripAnsi(out)).toBe('inline code mix');
  });

  it('passes empty string through unchanged', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('hides standalone proposed_plan wrapper tags', () => {
    const input = '<proposed_plan>\n# Summary\n- recon target\n</proposed_plan>';
    const stripped = stripAnsi(renderMarkdown(input));
    expect(stripped).toContain('Summary');
    expect(stripped).toContain('• recon target');
    expect(stripped).not.toContain('<proposed_plan>');
    expect(stripped).not.toContain('</proposed_plan>');
  });

  it('keeps newlines so the transcript can window correctly', () => {
    const out = renderMarkdown('line1\nline2\nline3');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('renders a link as "label (url)" with the label styled', () => {
    const out = renderMarkdown('see [the advisory](https://example.com/cve)');
    const stripped = stripAnsi(out);
    expect(stripped).toBe('see the advisory (https://example.com/cve)');
    // The label is actually styled (a style envelope is emitted), not raw.
    expect(out).not.toBe(stripped);
    // The raw markdown brackets are gone.
    expect(stripped).not.toContain('](');
  });

  it('collapses a link whose label equals its url to just the url', () => {
    const stripped = stripAnsi(renderMarkdown('[https://x.test](https://x.test)'));
    expect(stripped).toBe('https://x.test');
  });

  it('does not let underscores in a link url trigger italics', () => {
    const stripped = stripAnsi(renderMarkdown('[x](https://a.test/foo_bar_baz)'));
    expect(stripped).toBe('x (https://a.test/foo_bar_baz)');
  });

  it('renders a pipe table as an aligned grid', () => {
    const input = [
      '| Vuln | Severity |',
      '| --- | --- |',
      '| IDOR | High |',
      '| XSS | Medium |',
    ].join('\n');
    const lines = stripAnsi(renderMarkdown(input)).split('\n');
    expect(lines).toHaveLength(4); // header + rule + 2 body rows
    // Header cells present and column-padded to the widest cell ("Severity").
    expect(lines[0]).toContain('Vuln');
    expect(lines[0]).toContain('Severity');
    // Separator rule uses box-drawing chars aligned on the column join.
    expect(lines[1]).toContain('┼');
    expect(lines[1]).toMatch(/^─+┼─+$/);
    // Body rows aligned: the column separator sits at the same offset.
    expect(lines[2]?.indexOf('│')).toBe(lines[3]?.indexOf('│'));
    expect(lines[2]).toContain('IDOR');
    expect(lines[3]).toContain('Medium');
  });

  it('leaves a lone pipe line that is not a table untouched', () => {
    const stripped = stripAnsi(renderMarkdown('a | b without a separator row'));
    expect(stripped).toBe('a | b without a separator row');
  });
});
