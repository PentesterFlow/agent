import { describe, expect, it } from 'vitest';
import { stripThinkingTags } from './sanitize.js';

describe('stripThinkingTags', () => {
  it('removes complete think blocks', () => {
    expect(stripThinkingTags('<think>reasoning</think>\nAnswer')).toBe('Answer');
  });

  it('removes dangling closing think tags from local model output', () => {
    expect(stripThinkingTags('</think>\nAnswer')).toBe('Answer');
  });

  it('keeps trailing text after an unterminated think tag (does not blank the turn)', () => {
    // H7: an unclosed <think> means we can't tell where reasoning ends, so we
    // strip only the tag and preserve the text rather than erasing the whole
    // message (which previously blanked the turn / tripped the compaction breaker).
    expect(stripThinkingTags('<think>reasoning that never closed')).toBe(
      'reasoning that never closed',
    );
    expect(stripThinkingTags('<think>reasoning ... and the answer here')).toBe(
      'reasoning ... and the answer here',
    );
  });

  it('balances nested think blocks and leaves no stray closing tag', () => {
    // M14: peel nested pairs from the inside out; no leaked inner content or
    // dangling </think>.
    expect(stripThinkingTags('<think>a<think>b</think>visible</think>real')).toBe('real');
  });
});
