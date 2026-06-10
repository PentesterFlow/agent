// Strip <think>...</think> blocks from model output. Some local models
// (Qwen, DeepSeek-R1, GLM) emit visible reasoning blocks that aren't
// meant for the end user.

// Innermost matched pair: the body may not contain another `<think>`, so
// repeated application peels nested blocks from the inside out. `\s*` mops up
// whitespace left where the block was.
const THINK_PAIR_RE = /<think>(?:(?!<think>)[\s\S])*?<\/think>\s*/i;
// Leftover lone tags after all pairs are gone (an unclosed `<think>` or a stray
// `</think>`). We drop only the tag and keep the surrounding text.
const LONE_THINK_TAG_RE = /<\/?think>/gi;

/**
 * Remove reasoning blocks while preserving real answer text. Only *matched*
 * `<think>…</think>` pairs are deleted (handles nesting). An UNCLOSED `<think>`
 * has just its tag removed — the trailing text is kept, so a truncated/streamed
 * cutoff or an answer emitted inside an unterminated block is never erased
 * wholesale (which previously blanked the turn and could trip the compaction
 * circuit breaker).
 */
export function stripThinkingTags(s: string): string {
  if (!/<\/?think>/i.test(s)) return s;
  let out = s;
  let prev: string;
  do {
    prev = out;
    out = out.replace(THINK_PAIR_RE, '');
  } while (out !== prev);
  return out.replace(LONE_THINK_TAG_RE, '').trimStart();
}
