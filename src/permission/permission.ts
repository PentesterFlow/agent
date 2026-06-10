// Permission prompter. The TUI implements a Prompter that pops a modal
// asking "allow once / allow session / deny" for each tool call that
// requires permission. Tools call `prompter.ask(...)` and synchronously
// wait for a Decision before running.
//
// YOLO ("--yolo" / "--dangerously-skip-permissions") wraps a Prompter and
// short-circuits EVERY request to `allow-once`, bypassing the modal entirely
// — including sensitive-file and SSRF/private-host gates. This matches Claude
// Code's --dangerously-skip-permissions: skip all approvals. The shell
// denylist is a separate static guard inside the tool (a hard block, not a
// prompt) and still fires regardless of YOLO.

export type Decision = 'allow-once' | 'allow-session' | 'deny';

export interface Request {
  tool: string;
  summary: string;
  detail: string;
  /** When true, an "allow session" decision is honored once but NOT cached
   *  — the next equivalent call re-prompts. Used for high-consequence
   *  requests, such as credential-path file access, where blanket session
   *  consent should not silently carry forward. (Has no effect under YOLO,
   *  which auto-approves everything.) */
  noSessionCache?: boolean;
  /** Session-cache identity. An "allow session" decision caches approval for
   *  the (tool, cacheKey) pair; a request carrying a different cacheKey
   *  re-prompts. When absent, approval is cached for the whole tool (legacy
   *  broad behavior) — only safe for low-consequence tools. High-consequence
   *  tools (shell, http, file writes) supply a per-invocation key (the
   *  command, the request origin, the target path) so a single approval
   *  cannot silently whitelist every later call of that tool. */
  cacheKey?: string;
}

export interface Prompter {
  ask(req: Request, signal?: AbortSignal): Promise<Decision>;
}

/** Yolo wraps a Prompter and answers "allow-once" for every request without
 *  prompting — a complete skip of the approval flow when enabled. */
export class YoloPrompter implements Prompter {
  private inner: Prompter;
  private yolo = false;

  constructor(inner: Prompter, initial = false) {
    this.inner = inner;
    this.yolo = initial;
  }

  setYolo(on: boolean): void {
    this.yolo = on;
  }

  isYolo(): boolean {
    return this.yolo;
  }

  async ask(req: Request, signal?: AbortSignal): Promise<Decision> {
    // YOLO auto-approves everything — no carve-outs (matches Claude Code's
    // --dangerously-skip-permissions). The shell denylist still hard-blocks
    // catastrophic commands inside the tool, independently of this.
    if (this.yolo) return 'allow-once';
    return this.inner.ask(req, signal);
  }
}

/** AlwaysAllow is for headless / test contexts. Production must use a real prompter. */
export class AlwaysAllow implements Prompter {
  async ask(_req: Request): Promise<Decision> {
    return 'allow-once';
  }
}

/** AlwaysDeny is for hermetic tests that should never trigger a tool run. */
export class AlwaysDeny implements Prompter {
  async ask(_req: Request): Promise<Decision> {
    return 'deny';
  }
}
