// Agent: chat ↔ tool loop. The TUI
// invokes run() / compact() with an AbortSignal; the agent emits events
// via the provided sink (a callback or async-iterator adapter). emit()
// honors the signal so a wedged TUI can't keep the agent stuck.

import { type IntelligenceStore, formatIntelligenceContext } from '../intelligence/store.js';
import type { Client, StreamingClient } from '../llm/client.js';
import { isStreaming } from '../llm/client.js';
import type { ChatRequest, Message } from '../llm/types.js';
import { parsedArgs } from '../llm/types.js';
import { error as logError } from '../logger/logger.js';
import type { Prompter } from '../permission/permission.js';
import { redact } from '../redact/index.js';
import type { SessionMemory, Store } from '../session/store.js';
import { type Registry as SkillRegistry, materializeSkillBody } from '../skills/registry.js';
import type { Target } from '../target/target.js';
import { canonicalToolName } from '../tools/aliases.js';
import type { Registry as ToolRegistry } from '../tools/registry.js';
import { buildDecisionPlan } from './decisionPlanner.js';
import type { AgentEvent } from './events.js';
import { MaxStepsError } from './events.js';
import { expandFileMentions } from './mentions.js';
import { stripThinkingTags } from './sanitize.js';
import { type PromptProfile, type ToolingProfile, buildSystemPrompt } from './systemPrompt.js';

export type EventSink = (e: AgentEvent) => void;

export interface AgentRunOptions {
  /** When false, omit tool definitions and block any tool calls returned anyway. */
  tools?: boolean;
}

export interface AgentOptions {
  client: Client;
  tools: ToolRegistry;
  skills: SkillRegistry;
  prompter: Prompter;
  store: Store | null;
  target: Target;
  thinkingEnabled?: boolean;
  maxSteps?: number;
  /** When approxTokens() exceeds this number, the agent compacts before
   *  its next turn. 0 disables auto-compaction (manual /compact still
   *  works). Defaults to 16000 tokens. */
  autoCompactThreshold?: number;
  /** First-run picker choice. 'minimal' (default) keeps the curl-first
   *  ban on scanners; 'full' authorises ffuf/nuclei/sqlmap/etc. */
  toolingProfile?: ToolingProfile;
  /** Compact prompt profile for providers with small request/TPM caps. */
  promptProfile?: PromptProfile;
  /** When false, the agent calls `client.chat()` instead of
   *  `chatStream()`. Useful for backends/models where streaming is
   *  flaky (e.g. tool calls vanish from SSE deltas). Default: true. */
  streamingEnabled?: boolean;
  /** Local scan-intelligence dataset used to improve coverage across sessions. */
  intelligence?: IntelligenceStore | null;
  /** Operator-authored engagement notes (from .pentesterflow/engagement.md),
   *  always injected into the system prompt. Loaded once at startup. */
  engagement?: string;
}

/** How many consecutive auto-compaction failures we tolerate before
 *  giving up for the rest of the session. A circuit-breaker: if compaction itself is broken, we don't
 *  want to retry it on every turn. */
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
const COMPACTION_INPUT_CHAR_LIMIT = 22_000;
// Upper bound on retained items per memory list, so a long engagement can't
// grow the persisted checkpoint (and its disk footprint) without limit. The
// most recent items win; dedup happens in mergeList. Lists default to a much
// smaller cap (24) — findings/credentials get this larger one because losing
// an early confirmed finding is worse than carrying a few extra lines.
const MAX_MEMORY_LIST = 200;
const COMPACTION_SYSTEM_PROMPT =
  'Create a compact continuation memory for the same pentesting/coding session. Use concise Markdown with exactly these headings: Current objective, Plan, Completed tasks, Target and scope, Decisions and assumptions, Tested surface, Findings and evidence, Files and commands, Credentials and placeholders, Open TODOs, Next best actions. Preserve exact endpoints, params, IDs, files, commands, tool results that matter, confirmed negatives, and reproduction evidence. Redact secrets but keep stable placeholders. Omit chatter and failed dead ends unless they prevent repeat work.';

export class Agent {
  client: Client;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly prompter: Prompter;
  readonly store: Store | null;
  readonly target: Target;
  readonly intelligence: IntelligenceStore | null;

  private thinking: boolean;
  private maxSteps: number;
  private sysPrompt: string;
  private history: Message[];
  private memory: SessionMemory | null = null;
  // Operator-authored engagement notes (scope/rules/creds), loaded once at
  // startup from .pentesterflow/engagement.md. Always injected into the system
  // prompt — transcript-independent, so it survives compaction unconditionally.
  private engagement: string;
  private autoCompactThreshold: number;
  private consecutiveCompactFailures = 0;
  private toolingProfile: ToolingProfile;
  private promptProfile: PromptProfile;
  private streamingEnabled: boolean;
  // True while run() or compact() is mid-execution. Used to refuse a
  // client swap mid-turn — otherwise the in-flight chat continues against
  // the old client while subsequent loop iterations hit the new one.
  private running = false;
  // Skills loaded during the current turn (via load_skill OR /<name>
  // direct invoke). Used to compute the allowed-tools union; reset at
  // the start of each run() so old skill restrictions don't bleed into
  // a fresh user prompt.
  private activeSkills: Set<string> = new Set();
  // Skills explicitly invoked from slash commands before a turn starts.
  // These become active at the start of the next run, then are cleared.
  private pendingSkills: Set<string> = new Set();

  constructor(opts: AgentOptions) {
    this.client = opts.client;
    this.tools = opts.tools;
    this.skills = opts.skills;
    this.prompter = opts.prompter;
    this.store = opts.store ?? null;
    this.intelligence = opts.intelligence ?? null;
    this.target = opts.target;
    this.thinking = opts.thinkingEnabled ?? false;
    this.maxSteps = opts.maxSteps && opts.maxSteps > 0 ? opts.maxSteps : 20;
    this.autoCompactThreshold = opts.autoCompactThreshold ?? 16000;
    this.toolingProfile = opts.toolingProfile ?? 'minimal';
    this.promptProfile = opts.promptProfile ?? 'full';
    this.streamingEnabled = opts.streamingEnabled ?? true;
    this.engagement = opts.engagement ?? '';
    this.sysPrompt = buildSystemPrompt({
      skills: this.skills,
      thinkingEnabled: this.thinking,
      target: this.target,
      toolingProfile: this.toolingProfile,
      promptProfile: this.promptProfile,
      memory: this.memory,
      engagement: this.engagement,
    });
    this.history = [{ role: 'system', content: this.sysPrompt }];
  }

  // ---------- accessors ----------

  getHistory(): Message[] {
    return this.history.map((m) => ({ ...m }));
  }

  getMaxSteps(): number {
    return this.maxSteps;
  }

  setMaxSteps(n: number): void {
    if (n >= 1) this.maxSteps = n;
  }

  getAutoCompactThreshold(): number {
    return this.autoCompactThreshold;
  }

  getMemoryStats(): { compactions: number; items: number; lastCompactedAt?: string } {
    return {
      compactions: this.memory?.compactions ?? 0,
      items: countMemoryItems(this.memory),
      lastCompactedAt: this.memory?.lastCompactedAt,
    };
  }

  formatMemory(): string {
    if (!this.memory || countMemoryItems(this.memory) === 0) {
      return 'session memory is empty — run /compact after useful work accumulates.';
    }
    const m = this.memory;
    const out: string[] = [];
    out.push(`Session memory · ${m.compactions} compaction${m.compactions === 1 ? '' : 's'}`);
    if (m.lastCompactedAt) out.push(`Last compacted: ${m.lastCompactedAt}`);
    appendMemorySection(out, 'Objectives', m.objectives);
    appendMemorySection(out, 'Plan', m.plan);
    appendMemorySection(out, 'Completed', m.completed);
    appendMemorySection(out, 'Findings', m.findings);
    appendMemorySection(out, 'Tested surface', m.tested);
    appendMemorySection(out, 'Files', m.files);
    appendMemorySection(out, 'Commands', m.commands);
    appendMemorySection(out, 'Credentials / placeholders', m.credentials);
    appendMemorySection(out, 'TODOs', m.todos);
    return out.join('\n');
  }

  /**
   * Wipe the auto-generated session memory. The escape hatch for when a bad
   * compaction summary poisoned the carried state — the next /compact rebuilds
   * it from scratch. Operator-authored engagement notes are untouched (they
   * live in a file, not here).
   */
  async clearMemory(): Promise<void> {
    if (!this.memory || countMemoryItems(this.memory) === 0) return;
    this.memory = null;
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    await this.save();
  }

  /**
   * Remove individual memory items whose text contains `query`
   * (case-insensitive) across every list, so a single wrong line can be
   * dropped without nuking the whole checkpoint. Returns the removed items.
   */
  async forgetMemory(query: string): Promise<string[]> {
    const needle = query.trim().toLowerCase();
    if (!needle || !this.memory) return [];
    const removed: string[] = [];
    const prune = (items: string[]): string[] =>
      items.filter((item) => {
        if (item.toLowerCase().includes(needle)) {
          removed.push(item);
          return false;
        }
        return true;
      });
    this.memory = {
      ...this.memory,
      objectives: prune(this.memory.objectives),
      plan: prune(this.memory.plan),
      completed: prune(this.memory.completed),
      findings: prune(this.memory.findings),
      tested: prune(this.memory.tested),
      files: prune(this.memory.files),
      commands: prune(this.memory.commands),
      credentials: prune(this.memory.credentials),
      todos: prune(this.memory.todos),
    };
    if (removed.length === 0) return [];
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    await this.save();
    return removed;
  }

  async saveContextSnapshot(reason = 'periodic'): Promise<string> {
    if (!this.store) return '';
    const out: string[] = [];
    out.push('# PentesterFlow Session Context');
    out.push('');
    out.push(`Updated: ${new Date().toISOString()}`);
    out.push(`Reason: ${reason}`);
    out.push(`Provider: ${this.client.name()}`);
    out.push(`Model: ${this.client.model()}`);
    out.push(`Target: ${this.target.baseURL() || this.target.name() || '(none)'}`);
    out.push(`Approx tokens: ${this.approxTokens()}`);
    out.push('');
    out.push('## Persistent Memory');
    out.push('');
    out.push(this.formatMemory());
    out.push('');
    out.push('## Redacted Conversation Context');
    out.push('');
    out.push(formatHistoryForCompaction(this.history.slice(1)));
    return this.store.saveContextSnapshot(out.join('\n'));
  }

  async coverageContext(signal: AbortSignal): Promise<string> {
    if (!this.tools.get('coverage')) return 'Coverage tool is not available in this session.';
    const summary = await this.tools
      .execute('coverage', { action: 'summary' }, signal, this.prompter)
      .catch((err: unknown) => `error: ${errMessage(err)}`);
    const entries = await this.tools
      .execute('coverage', { action: 'list' }, signal, this.prompter)
      .catch((err: unknown) => `error: ${errMessage(err)}`);
    return [
      'Coverage summary:',
      summary,
      '',
      'Coverage entries:',
      entries,
      '',
      'Use this coverage state to choose next tests. Prefer untested endpoint/parameter/vulnerability-class combinations. Do not repeat entries already marked passed, failed, skipped, waf-blocked, or tried unless the objective explicitly asks for retesting.',
    ].join('\n');
  }

  /** Set the auto-compact threshold (in approxTokens). 0 disables. */
  setAutoCompactThreshold(n: number): void {
    this.autoCompactThreshold = Math.max(0, Math.floor(n));
  }

  setPromptProfile(profile: PromptProfile): void {
    if (this.promptProfile === profile) return;
    this.promptProfile = profile;
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
  }

  thinkingIsEnabled(): boolean {
    return this.thinking;
  }

  async setThinkingEnabled(on: boolean): Promise<void> {
    this.thinking = on;
    this.rebuildSystemPrompt();
    await this.save();
  }

  /**
   * Toggle a skill's enabled state on the shared registry, then rebuild
   * the system prompt so the change takes effect on the next turn.
   * Returns whether the state actually changed (false if it was already
   * in the requested state, or if the skill doesn't exist).
   *
   * Persisting to ~/.pentesterflow/config.json is the caller's job —
   * the agent only knows about its in-memory state.
   */
  async setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
    if (!this.skills.has(name)) return false;
    const changed = this.skills.setDisabled(name, !enabled);
    if (!changed) return false;
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    await this.save();
    return true;
  }

  /**
   * Swap the active LLM client. Throws if a turn is in flight — callers
   * (e.g. /provider, /model) must wait for the current run to settle before
   * switching, otherwise the in-flight chat would continue against the old
   * client while subsequent iterations hit the new one (and usePing would
   * see the new readiness state mid-turn).
   */
  setClient(client: Client): void {
    if (this.running) {
      throw new Error(
        'cannot switch model/provider while a turn is in flight — cancel first with Esc',
      );
    }
    this.client = client;
  }

  /** True while run() or compact() is executing. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Re-derive the system prompt from the current state of the shared
   * skill registry. Called by the live-reload watcher in CLI after the
   * registry has been reloaded from disk — without this, edits to a
   * skill file wouldn't reach the model until restart. Safe to call
   * during a turn (we just update the system message in history; the
   * in-flight chat already has its messages serialized).
   */
  rebuildFromSkills(): void {
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
  }

  /**
   * Inject a skill's body into the session history as a synthetic
   * system note, the way a `/<skill-name>` direct invoke
   * works. The next user turn sees the skill content as if the model
   * had loaded it via load_skill. Throws if the skill is missing,
   * disabled, or a turn is in flight. Returns the skill name on success.
   *
   * Direct-invoke deliberately bypasses the `disable-model-invocation`
   * flag — that flag is about hiding skills from the model's automatic
   * decision-making, not about blocking the user from running them.
   */
  async injectSkill(name: string): Promise<string> {
    if (this.running) {
      throw new Error('cannot load a skill while a turn is in flight — cancel first with Esc');
    }
    const s = this.skills.get(name);
    if (!s) throw new Error(`unknown skill "${name}"`);
    if (this.skills.isDisabled(name)) {
      throw new Error(`skill "${name}" is disabled — enable it from /skills first`);
    }
    const body = materializeSkillBody(s);
    this.history.push({
      role: 'system',
      content: `The user invoked /${name}. Apply this skill to the next request:\n\n${body}`,
    });
    // Track as active so the allowed-tools enforcer treats this skill as
    // loaded for the upcoming turn.
    this.pendingSkills.add(name);
    await this.save();
    return name;
  }

  /**
   * Check whether a tool call is permitted given the currently-active
   * skills' allowed-tools lists. Policy:
   *
   *   1. No active skills → no restriction (backward-compatible).
   *   2. Tool doesn't require permission → always allowed (load_skill,
   *      read_payloads, read_skill_file, coverage, ask, confirm_finding,
   *      file_read, glob, grep, web_fetch, web_search). These are
   *      workflow / observational and shouldn't be skill-gated.
   *   3. Any active skill OMITS allowed-tools → no restriction. By
   *      convention, an empty allowed-tools means "inherit all tools",
   *      so an unrestricted active skill leaves the agent unrestricted.
   *   4. Any active skill lists the tool in its `allowed-tools` →
   *      allowed. (Union semantics: loading multiple skills broadens
   *      what's allowed.)
   *   5. Else → blocked, with a message naming the active skills and the
   *      tools each allows, so the model knows what to do (load a
   *      different skill, or give up on the disallowed action).
   */
  private isToolAllowed(toolName: string): { ok: boolean; reason?: string } {
    if (this.activeSkills.size === 0) return { ok: true };
    const t = this.tools.get(toolName);
    if (!t) return { ok: true }; // unknown tool — let downstream fail with a clearer error
    if (!t.requiresPermission()) return { ok: true }; // workflow primitive
    const activeSkills = [...this.activeSkills]
      .map((n) => this.skills.get(n))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    // No resolvable active skill, or any active skill that omits
    // allowed-tools → unrestricted (omit = inherit all tools).
    if (activeSkills.length === 0) return { ok: true };
    if (activeSkills.some((s) => s.tools.length === 0)) return { ok: true };
    // pentesterflow registers tools under two names (Unix and
    // PascalCase — `shell` AND `BashTool`, `file_write` AND
    // `FileWriteTool`, etc.) so models trained against either corpus
    // can call them. The skill author writes the canonical Unix name
    // in `allowed-tools`; canonicalize both sides before comparing so
    // calling `BashTool` under a skill that allows `shell` succeeds.
    const wantedCanonical = canonicalToolName(toolName);
    const allowedBy = activeSkills.filter((s) =>
      s.tools.map((n) => canonicalToolName(n)).includes(wantedCanonical),
    );
    if (allowedBy.length > 0) return { ok: true };
    const summary = [...this.activeSkills]
      .map((n) => {
        const sk = this.skills.get(n);
        const list = sk && sk.tools.length > 0 ? sk.tools.join(', ') : '(none)';
        return `${n} (allows: ${list})`;
      })
      .join('; ');
    return {
      ok: false,
      reason: `tool "${toolName}" is not in any active skill's allowed-tools list. Active skills: ${summary}. To use this tool, either load a skill that allows it (try \`load_skill name=...\`), /reset to clear active-skill restrictions, or choose a different approach.`,
    };
  }

  approxTokens(): number {
    let total = 0;
    for (const m of this.history) {
      total += Math.floor(m.content.length / 4);
      for (const tc of m.toolCalls ?? []) {
        total += Math.floor((tc.function.name.length + tc.function.arguments.length) / 4);
      }
    }
    return total;
  }

  // ---------- session lifecycle ----------

  async reset(): Promise<void> {
    this.history = [{ role: 'system', content: this.sysPrompt }];
    this.memory = null;
    // A reset wipes the conversation; allowed-tools restrictions from
    // previously-loaded skills should go too, otherwise the user is
    // stuck with a stale allowlist on a fresh session.
    this.activeSkills.clear();
    this.pendingSkills.clear();
    // Clear the auto-compact circuit breaker so a fresh session isn't born with
    // compaction already disabled from a previous session's failures (M4).
    this.consecutiveCompactFailures = 0;
    if (this.store) await this.store.clear();
  }

  hasSavedSession(): boolean {
    if (!this.store) return false;
    try {
      const loaded = this.store.load();
      return loaded.messages.length > 1;
    } catch {
      return false;
    }
  }

  resumeSaved(): void {
    if (!this.store) return;
    const loaded = this.store.load();
    if (loaded.target) this.target.copyFrom(loaded.target);
    this.memory = loaded.memory;
    this.rebuildSystemPrompt();
    if (loaded.messages.length === 0) {
      this.history = [{ role: 'system', content: this.sysPrompt }];
      return;
    }
    // Repair any dangling tool_calls a prior session aborted mid-loop, else
    // the first resumed request 400s on an unanswered call (H6).
    this.history = reconcileToolCalls(ensureSystemPrompt(loaded.messages, this.sysPrompt));
  }

  async setTargetBaseURL(u: string): Promise<void> {
    this.target.setBaseURL(u);
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    await this.save();
  }

  async clearTarget(): Promise<void> {
    this.target.clear();
    this.rebuildSystemPrompt();
    this.history = ensureSystemPrompt(this.history, this.sysPrompt);
    await this.save();
  }

  // ---------- main loop ----------

  async run(
    userMsg: string,
    signal: AbortSignal,
    emit: EventSink,
    opts?: AgentRunOptions,
  ): Promise<void> {
    const safeEmit = makeSafeEmit(signal, emit);
    this.running = true;
    try {
      await this.runInner(userMsg, signal, safeEmit, opts);
    } catch (err) {
      if (signal.aborted || isAbortLikeError(err)) {
        safeEmit({ type: 'error', err: new Error('turn cancelled') });
        return;
      }
      logError('agent: panic in Run', { err: errMessage(err) });
      safeEmit({ type: 'error', err: err instanceof Error ? err : new Error(String(err)) });
    } finally {
      this.running = false;
      safeEmit({ type: 'done' });
    }
  }

  async compact(signal: AbortSignal, emit: EventSink): Promise<void> {
    const safeEmit = makeSafeEmit(signal, emit);
    this.running = true;
    try {
      const historySnap = this.history.slice();
      if (historySnap.length <= 1) {
        safeEmit({ type: 'compact', summary: 'nothing to compact' });
        return;
      }
      const req: ChatRequest = {
        model: this.client.model(),
        messages: [
          {
            role: 'system',
            content: COMPACTION_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: boundedHistoryForCompaction(historySnap.slice(1)),
          },
        ],
      };
      const resp = await this.client.chat(req, signal);
      const summary = stripThinkingTags(resp.message.content);
      if (!summary) {
        safeEmit({ type: 'error', err: new Error('compact returned empty summary') });
        return;
      }
      this.memory = mergeMemory(this.memory, summary);
      // Fold the freshly merged checkpoint into the system prompt before it is
      // seeded into the reset history below, so accumulated state survives this
      // compaction (and every restart) instead of only the latest summary.
      this.rebuildSystemPrompt();
      // A successful manual /compact proves compaction works again, so clear
      // the auto-compact circuit breaker that prior auto failures may have
      // tripped — otherwise it stays disabled for the whole process (M4).
      this.consecutiveCompactFailures = 0;
      await this.learnIntelligence(summary);
      this.history = [
        { role: 'system', content: this.sysPrompt },
        {
          role: 'user',
          content: `Session context was compacted. Continue from this summary:\n\n${summary}`,
        },
      ];
      await this.save().catch((err) =>
        safeEmit({ type: 'error', err: new Error(`save compacted session: ${errMessage(err)}`) }),
      );
      await this.saveContextSnapshot('manual compact').catch((err) =>
        safeEmit({ type: 'error', err: new Error(`save context snapshot: ${errMessage(err)}`) }),
      );
      safeEmit({ type: 'compact', summary, memoryItems: countMemoryItems(this.memory) });
    } catch (err) {
      logError('agent: panic in Compact', { err: errMessage(err) });
      safeEmit({ type: 'error', err: err instanceof Error ? err : new Error(String(err)) });
    } finally {
      this.running = false;
      safeEmit({ type: 'done' });
    }
  }

  private async runInner(
    userMsg: string,
    signal: AbortSignal,
    emit: EventSink,
    opts?: AgentRunOptions,
  ): Promise<void> {
    this.activeSkills = new Set(this.pendingSkills);
    this.pendingSkills.clear();

    // Repair any dangling assistant tool_calls left by a previously aborted
    // turn before this turn's user message is appended, so the request we send
    // (and the next save) can't carry an unanswered tool call into a provider
    // 400 (H6).
    this.history = reconcileToolCalls(this.history);

    // Expand @file mentions once. The expanded text is both what we size this
    // turn against for the auto-compact gate (M5 — a large @file attachment
    // must count toward the threshold) and the content actually sent below.
    const expandedUserMsg = expandFileMentions(userMsg);
    const incomingTokens = Math.floor(Buffer.byteLength(expandedUserMsg, 'utf8') / 4);

    // Auto-compact gate. Run BEFORE we add the new user message so the
    // compaction summary doesn't include this turn's question — the
    // user expects their prompt to be answered, not summarized away.
    // Includes the incoming (post-expansion) message size so a near-threshold
    // turn plus a large attachment can't blow past the context window with no
    // compaction (M5). Circuit breaker: stop retrying if we've failed N times
    // in a row; the user can still call /compact manually to investigate.
    if (
      this.autoCompactThreshold > 0 &&
      this.consecutiveCompactFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES &&
      this.approxTokens() + incomingTokens >= this.autoCompactThreshold
    ) {
      await this.autoCompact(signal, emit);
    }

    const decision =
      opts?.tools === false
        ? undefined
        : buildDecisionPlan(userMsg, this.skills.listEnabled(), this.target);
    if (decision) {
      if (decision.recommendedSkill) {
        emit({
          type: 'decision',
          summary: `decision planner: selected skill: ${decision.recommendedSkill} · risk: ${decision.risk} · ${decision.reason}`,
        });
      }
    }

    // Persist the raw user message (un-expanded mentions) so the on-disk
    // session doesn't leak file contents the user inlined via @path.
    this.history.push({ role: 'user', content: userMsg });
    const working = this.history.map((m) => ({ ...m }));
    await this.save().catch((err) =>
      emit({ type: 'error', err: new Error(`save session: ${errMessage(err)}`) }),
    );

    const last = working[working.length - 1];
    if (decision && last) {
      working.splice(working.length - 1, 0, { role: 'system', content: decision.guidance });
    }
    const intelligenceContext = this.buildIntelligenceContext(userMsg);
    if (intelligenceContext && last) {
      working.splice(working.length - 1, 0, { role: 'system', content: intelligenceContext });
    }
    if (last) last.content = expandedUserMsg;

    const maxSteps = this.maxSteps;
    for (let step = 0; step < maxSteps; step += 1) {
      if (signal.aborted) throw new Error('aborted');

      const req: ChatRequest = {
        model: this.client.model(),
        messages: working,
      };
      if (opts?.tools !== false) req.tools = this.tools.asLLMTools();
      const { resp, streamed } = await this.chat(req, signal, emit);
      resp.message.content = stripThinkingTags(resp.message.content);
      const toolCalls = resp.message.toolCalls ?? [];
      const hasToolCalls = toolCalls.length > 0;

      if (opts?.tools === false && hasToolCalls) {
        if (resp.message.content && !streamed) {
          emit({ type: 'assistant-text', text: resp.message.content });
        }
        emit({ type: 'error', err: new Error('plan-only mode blocked tool calls') });
        return;
      }

      this.history.push(resp.message);
      working.push(resp.message);
      await this.save().catch((err) =>
        emit({ type: 'error', err: new Error(`save session: ${errMessage(err)}`) }),
      );

      if (resp.message.content && !streamed) {
        emit({ type: 'assistant-text', text: resp.message.content });
      }
      if (!hasToolCalls) {
        await this.learnIntelligence(buildTurnLearningText(userMsg, resp.message.content));
        return;
      }

      for (const tc of toolCalls) {
        if (signal.aborted) throw new Error('aborted');
        let args: Record<string, unknown> = {};
        let parseErr: Error | undefined;
        try {
          args = parsedArgs(tc.function);
        } catch (err) {
          parseErr = err instanceof Error ? err : new Error(String(err));
        }
        const argsJSON = tc.function.arguments;
        emit({
          type: 'tool-call',
          id: tc.id,
          name: tc.function.name,
          args,
          argsJSON,
        });

        const start = Date.now();
        let result = '';
        let runErr: Error | undefined;
        if (parseErr) {
          runErr = new Error(`could not parse arguments: ${parseErr.message} (raw: ${argsJSON})`);
        } else {
          // Enforce the active skills' allowed-tools union before
          // dispatch. Soft-fail (set runErr) instead of throwing so the
          // model sees the error as a tool result and can self-correct
          // — usually by loading a different skill or by giving up on
          // the disallowed action. Workflow tools (load_skill,
          // coverage, read_*, ask, finding, browser_capture_*) are
          // always allowed regardless of which skill is active.
          const allowed = this.isToolAllowed(tc.function.name);
          if (!allowed.ok) {
            runErr = new Error(allowed.reason ?? 'tool blocked by active skills');
          } else {
            try {
              result = await this.tools.execute(tc.function.name, args, signal, this.prompter);
            } catch (err) {
              runErr = err instanceof Error ? err : new Error(String(err));
            }
          }
        }
        const durationMs = Date.now() - start;
        let errStr = '';
        if (runErr) {
          errStr = runErr.message;
          result = `ERROR: ${errStr}`;
          logError('agent: tool failed', {
            tool: tc.function.name,
            duration_ms: durationMs,
            err: errStr,
          });
        }
        emit({
          type: 'tool-result',
          id: tc.id,
          name: tc.function.name,
          result,
          err: errStr,
          durationMs,
        });

        if (tc.function.name === 'load_skill' && !runErr) {
          const nm = typeof args.name === 'string' ? args.name : '';
          if (nm) {
            this.activeSkills.add(nm);
            emit({ type: 'skill-active', name: nm });
          }
        }

        const toolMsg: Message = {
          role: 'tool',
          content: result,
          toolCallID: tc.id,
          name: tc.function.name,
        };
        this.history.push(toolMsg);
        working.push(toolMsg);
        await this.save().catch((err) =>
          emit({ type: 'error', err: new Error(`save session: ${errMessage(err)}`) }),
        );
      }
    }
    emit({ type: 'error', err: new MaxStepsError(maxSteps) });
  }

  private async chat(
    req: ChatRequest,
    signal: AbortSignal,
    emit: EventSink,
  ): Promise<{ resp: Awaited<ReturnType<Client['chat']>>; streamed: boolean }> {
    if (this.streamingEnabled && isStreaming(this.client)) {
      const c: StreamingClient = this.client;
      const resp = await c.chatStream(
        { ...req, stream: true },
        (delta) => {
          if (delta) emit({ type: 'assistant-delta', text: delta });
        },
        signal,
      );
      return { resp, streamed: true };
    }
    const resp = await this.client.chat(req, signal);
    return { resp, streamed: false };
  }

  // ---------- internals ----------

  /**
   * Compact the history before the user's next message lands. The
   * autoCompact gating emits a system event so the user
   * sees what's happening, track consecutive failures so we don't loop
   * forever if compaction itself is broken. The user's pending message
   * is NOT included in the compaction prompt — runInner adds it after
   * we return.
   */
  private async autoCompact(signal: AbortSignal, emit: EventSink): Promise<void> {
    const tokensBefore = this.approxTokens();
    emit({
      type: 'compact',
      summary: `auto-compact triggered (~${tokensBefore} tokens ≥ threshold ${this.autoCompactThreshold})…`,
      tokensBefore,
    });

    let compactionSucceeded = false;
    try {
      await this.compactInPlace(signal);
      compactionSucceeded = true;
    } catch (err) {
      this.consecutiveCompactFailures += 1;
      logError('agent: auto-compact failed', {
        err: errMessage(err),
        consecutive: this.consecutiveCompactFailures,
      });
      emit({
        type: 'error',
        err: new Error(
          `auto-compact failed (${this.consecutiveCompactFailures}/${MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES}): ${errMessage(err)}`,
        ),
      });
    }

    if (compactionSucceeded) {
      this.consecutiveCompactFailures = 0;
      const tokensAfter = this.approxTokens();
      emit({
        type: 'compact',
        summary: `auto-compacted: ~${tokensBefore} → ~${tokensAfter} tokens`,
        tokensBefore,
        tokensAfter,
        memoryItems: countMemoryItems(this.memory),
      });
    }
  }

  /**
   * The core compaction work without the event-emission ceremony that
   * the public compact() does. Sends the current history to the model
   * with a summarize-prompt, replaces history with [system, summary]
   * on success. Throws on any error so autoCompact can update the
   * failure counter.
   */
  private async compactInPlace(signal: AbortSignal): Promise<void> {
    const historySnap = this.history.slice();
    if (historySnap.length <= 1) return;
    const req: ChatRequest = {
      model: this.client.model(),
      messages: [
        {
          role: 'system',
          content: COMPACTION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: boundedHistoryForCompaction(historySnap.slice(1)),
        },
      ],
    };
    const resp = await this.client.chat(req, signal);
    const summary = stripThinkingTags(resp.message.content);
    if (!summary) {
      throw new Error('compact returned empty summary');
    }
    this.memory = mergeMemory(this.memory, summary);
    // Fold the merged checkpoint into the system prompt before seeding the
    // reset history, so cumulative state (not just this summary) rides forward.
    this.rebuildSystemPrompt();
    await this.learnIntelligence(summary);
    this.history = [
      { role: 'system', content: this.sysPrompt },
      {
        role: 'user',
        content: `Session context was compacted. Continue from this summary:\n\n${summary}`,
      },
    ];
    await this.save();
    await this.saveContextSnapshot('auto compact');
  }

  private rebuildSystemPrompt(): void {
    this.sysPrompt = buildSystemPrompt({
      skills: this.skills,
      thinkingEnabled: this.thinking,
      target: this.target,
      toolingProfile: this.toolingProfile,
      promptProfile: this.promptProfile,
      memory: this.memory,
      engagement: this.engagement,
    });
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    await this.store.save(this.history, this.target, this.memory);
  }

  private buildIntelligenceContext(userMsg: string): string {
    if (!this.intelligence) return '';
    const query = [
      userMsg,
      this.target.baseURL(),
      this.target.name(),
      this.memory?.lastSummary ?? '',
      ...(this.memory?.objectives ?? []),
      ...(this.memory?.tested ?? []),
      ...(this.memory?.files ?? []),
      ...(this.memory?.todos ?? []),
    ].join('\n');
    const results = this.intelligence.search(query, 5).filter((r) => r.score >= 6);
    return formatIntelligenceContext(results);
  }

  private async learnIntelligence(summary: string): Promise<void> {
    if (!this.intelligence) return;
    const sourceSessionId = this.store?.id || undefined;
    try {
      await this.intelligence.learnFromText(summary, sourceSessionId);
    } catch (err) {
      logError('agent: intelligence learning failed', { err: errMessage(err) });
    }
  }
}

// ---------- helpers ----------

function ensureSystemPrompt(messages: Message[], prompt: string): Message[] {
  if (messages.length === 0 || messages[0]?.role !== 'system') {
    return [{ role: 'system', content: prompt }, ...messages];
  }
  if (messages[0].content === prompt) return messages;
  return [{ role: 'system', content: prompt }, ...messages.slice(1)];
}

/**
 * Repair dangling tool calls. The OpenAI/Kimi/etc. wire format requires every
 * assistant `tool_calls` entry to be answered by a following `role:'tool'`
 * message with the matching id before the next user/assistant turn. A turn
 * aborted (Esc) between emitting the assistant tool_calls and recording the
 * tool results leaves an unanswered call on disk; replaying it provokes a hard
 * 400 that wedges the session until /reset. This synthesizes a result for any
 * unanswered call so the history is always valid to resend. Returns a repaired
 * copy (the input is not mutated); a no-op when nothing is dangling.
 */
export function reconcileToolCalls(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    out.push(m);
    if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) continue;

    // Consume the tool results that immediately follow this assistant message.
    const answered = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || next.role !== 'tool') break;
      if (next.toolCallID) answered.add(next.toolCallID);
      out.push(next);
    }
    // Synthesize a result for any call the aborted turn never answered.
    for (const tc of m.toolCalls) {
      if (tc.id && !answered.has(tc.id)) {
        out.push({
          role: 'tool',
          content:
            'ERROR: tool call did not complete (the turn was interrupted before this tool produced a result).',
          toolCallID: tc.id,
          name: tc.function?.name,
        });
      }
    }
    i = j - 1;
  }
  return out;
}

function buildTurnLearningText(userMsg: string, assistantMsg: string): string {
  return [
    '## User preferences and working style',
    userMsg,
    '',
    '## Task outcome',
    assistantMsg,
  ].join('\n');
}

function emptyMemory(): SessionMemory {
  const now = new Date().toISOString();
  return {
    version: 1,
    updatedAt: now,
    compactions: 0,
    objectives: [],
    plan: [],
    completed: [],
    findings: [],
    tested: [],
    files: [],
    commands: [],
    credentials: [],
    todos: [],
  };
}

function mergeMemory(prev: SessionMemory | null, summary: string): SessionMemory {
  const now = new Date().toISOString();
  const parsed = parseCompactionSummary(summary);
  return {
    ...(prev ?? emptyMemory()),
    updatedAt: now,
    lastCompactedAt: now,
    lastSummary: summary,
    compactions: (prev?.compactions ?? 0) + 1,
    objectives: mergeList(prev?.objectives, parsed.objectives),
    plan: mergeList(prev?.plan, parsed.plan),
    completed: mergeList(prev?.completed, parsed.completed),
    findings: mergeList(prev?.findings, parsed.findings, MAX_MEMORY_LIST),
    tested: mergeList(prev?.tested, parsed.tested),
    files: mergeList(prev?.files, parsed.files),
    commands: mergeList(prev?.commands, parsed.commands),
    credentials: mergeList(prev?.credentials, parsed.credentials, MAX_MEMORY_LIST),
    todos: mergeList(prev?.todos, parsed.todos),
  };
}

function parseCompactionSummary(
  summary: string,
): Omit<
  SessionMemory,
  'version' | 'updatedAt' | 'compactions' | 'lastCompactedAt' | 'lastSummary'
> {
  const sections = splitMarkdownSections(summary);
  return {
    objectives: sectionItems(sections, ['current objective', 'target and scope']),
    plan: sectionItems(sections, ['plan']),
    completed: sectionItems(sections, ['completed tasks']),
    findings: sectionItems(sections, ['findings and evidence']),
    tested: sectionItems(sections, ['tested surface', 'decisions and assumptions']),
    files: sectionItems(sections, ['files and commands']).filter((s) =>
      /(?:^|[\s/])[\w.-]+\.\w+|\/|\\/.test(s),
    ),
    commands: sectionItems(sections, ['files and commands']).filter((s) =>
      /`[^`]+`|\b(?:curl|npm|git|rg|python|node|ffuf|nuclei|sqlmap|httpx)\b/.test(s),
    ),
    credentials: sectionItems(sections, ['credentials and placeholders']),
    todos: sectionItems(sections, ['open todos', 'next best actions']),
  };
}

function splitMarkdownSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = 'summary';
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = raw.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading?.[1]) {
      current = normalizeHeading(heading[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)?.push(raw);
  }
  return sections;
}

function sectionItems(sections: Map<string, string[]>, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names.map(normalizeHeading)) {
    for (const line of sections.get(name) ?? []) {
      const item = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim();
      if (!item || /^none\b|^n\/a$/i.test(item)) continue;
      out.push(item);
    }
  }
  return out;
}

function normalizeHeading(s: string): string {
  return s.toLowerCase().replace(/[:#]/g, '').trim();
}

function mergeList(prev: string[] | undefined, next: string[], cap = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...(prev ?? []), ...next]) {
    const clean = item.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean.length > 240 ? `${clean.slice(0, 239)}…` : clean);
  }
  return Number.isFinite(cap) ? out.slice(-cap) : out;
}

function countMemoryItems(memory: SessionMemory | null): number {
  if (!memory) return 0;
  return (
    memory.objectives.length +
    memory.plan.length +
    memory.completed.length +
    memory.findings.length +
    memory.tested.length +
    memory.files.length +
    memory.commands.length +
    memory.credentials.length +
    memory.todos.length
  );
}

function appendMemorySection(out: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  out.push('');
  out.push(title);
  for (const item of items.slice(-8)) out.push(`- ${item}`);
}

function formatHistoryForCompaction(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (!m.content && (!m.toolCalls || m.toolCalls.length === 0)) continue;
    lines.push(`\n[${m.role}${m.name ? `:${m.name}` : ''}]`);
    if (m.content) {
      // Scrub credentials before they're sent back to the LLM as a
      // summarization prompt. Tool output captured during the session
      // frequently echoes bearer tokens / cloud keys.
      lines.push(redact.apply(m.content));
    }
    for (const tc of m.toolCalls ?? []) {
      lines.push(`tool_call ${tc.id} ${tc.function.name} ${redact.apply(tc.function.arguments)}`);
    }
  }
  return lines.join('\n');
}

function boundedHistoryForCompaction(messages: Message[]): string {
  const full = formatHistoryForCompaction(messages);
  if (full.length <= COMPACTION_INPUT_CHAR_LIMIT) return full;
  const tail = full.slice(-COMPACTION_INPUT_CHAR_LIMIT);
  const boundary = tail.indexOf('\n[');
  const trimmed = boundary > 0 ? tail.slice(boundary) : tail;
  return [
    `[system]\nOlder conversation text was omitted because the compaction input exceeded ${COMPACTION_INPUT_CHAR_LIMIT} characters. Preserve continuity from persistent memory and the newest visible context below.`,
    trimmed,
  ].join('\n');
}

/** Wrap the user-supplied event sink so signal-cancel never wedges callers. */
function makeSafeEmit(signal: AbortSignal, emit: EventSink): EventSink {
  return (e: AgentEvent) => {
    if (signal.aborted && e.type !== 'done' && e.type !== 'error') return;
    try {
      emit(e);
    } catch {
      // Swallow — the agent never depends on the UI keeping up.
    }
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return err.name === 'AbortError' || msg === 'aborted' || msg.includes('operation was aborted');
}
