// Single source of truth for the chalk color level the TUI uses.
//
// The transcript is always rendered by Ink (which requires a TTY), so we
// normally force truecolor (level 3) — chalk would otherwise suppress ANSI
// when its own TTY detection misfires (test runs, wrappers, Ink alt-screen
// edge cases), leaving syntax highlighting and tool coloring as plain prose.
//
// But we honor the de-facto `NO_COLOR` standard (https://no-color.org): when
// NO_COLOR is set to any non-empty value, every chalk instance in the UI
// drops to level 0 (no ANSI). Keep this in lockstep with cli/forceColor.ts,
// which gates FORCE_COLOR on the same signal.

/** True when the user has requested no color output via NO_COLOR. */
export function noColorRequested(): boolean {
  const v = process.env.NO_COLOR;
  return typeof v === 'string' && v !== '';
}

/** chalk color level for the UI: 0 when NO_COLOR is set, else truecolor (3). */
export function chalkLevel(): 0 | 3 {
  return noColorRequested() ? 0 : 3;
}
