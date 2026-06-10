// Force chalk-based libraries (cli-highlight, etc.) to emit ANSI even
// when their internal TTY detection comes back false. This module is
// side-effect-only — import it FIRST in cli/index.ts so the env var is
// set before any chalk-consuming module is imported.
//
// Why: cli-highlight constructs its own chalk instance on import. That
// instance reads `process.stdout.isTTY` + supportsColor at module-load
// time and caches a level. If detection returns 0 (some terminals,
// wrappers, or Ink alt-screen edge cases), cli-highlight silently
// emits unstyled text — which made Python / bash / json code blocks
// in the transcript appear as plain prose instead of syntax-coloured.
//
// We honor a user override: if FORCE_COLOR is already set in the env
// (intentionally or by a no-color tool), we leave it alone. We also honor
// the NO_COLOR standard (https://no-color.org): when NO_COLOR is set, we do
// NOT force color on — the UI's chalk instances drop to level 0 to match
// (see ui/colorLevel.ts).

const noColor = typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR !== '';
if (!process.env.FORCE_COLOR && !noColor) {
  process.env.FORCE_COLOR = '3';
}

export {};
