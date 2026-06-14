# PentesterFlow — Complete Project Documentation

> **`@pentesterflow/agent`** — Human-in-the-loop agentic AI CLI for penetration testers
> and bug hunters. An open-source terminal assistant for *authorized* offensive-security
> work that connects to local or hosted LLMs, plans against a scoped target, runs real
> pentesting tools behind permission gates, remembers lessons across sessions, and writes
> evidence-backed findings.

- **Package:** `@pentesterflow/agent` · version `0.1.0-dev`
- **License:** Apache-2.0 · **Node:** `>=20`
- **Language:** TypeScript (ESM) · ~24,000 LOC across 143 source files · 57 test files
- **Runtime UI:** Ink (React for the terminal)
- **Binaries:** `pentesterflow` (the CLI) and `pentesterflow-browser-mcp` (capture MCP server)
- **Repo homepage:** https://github.com/pentesterflow/agent

---

## Table of Contents

1. [What it is & design philosophy](#1-what-it-is--design-philosophy)
2. [High-level architecture](#2-high-level-architecture)
3. [Startup & the CLI entry point](#3-startup--the-cli-entry-point)
4. [The agent loop](#4-the-agent-loop)
5. [LLM providers](#5-llm-providers)
6. [Tools](#6-tools)
7. [Permission & security model](#7-permission--security-model)
8. [Skills system](#8-skills-system)
9. [Memory, sessions & continuous learning](#9-memory-sessions--continuous-learning)
10. [Coverage & findings](#10-coverage--findings)
11. [Browser / Burp capture & MCP](#11-browser--burp-capture--mcp)
12. [Terminal UI (Ink/React)](#12-terminal-ui-inkreact)
13. [Configuration & data paths](#13-configuration--data-paths)
14. [Cross-cutting: redaction, logging, target, update, version](#14-cross-cutting-utilities)
15. [Slash commands & CLI flags reference](#15-slash-commands--cli-flags-reference)
16. [Build, test & developer workflow](#16-build-test--developer-workflow)
17. [Directory map](#17-directory-map)

---

## 1. What it is & design philosophy

PentesterFlow assists across the full pentest lifecycle — **scope → recon → enumeration →
validation → coverage → reporting → learning** — while keeping the analyst in control.

It is built around three ideas:

- **Analyst control** — the human approves sensitive actions and decides scope.
- **Transparent execution** — curl-first, reproducible commands, visible tool calls, saved
  evidence, audit-friendly JSON-lines logs.
- **Operational learning** — local project + personal knowledge bases improve future
  sessions without retraining the model or adding user-facing complexity.

> ⚠️ **Authorized use only.** The agent can run shell commands, make HTTP requests, edit
> files, and process captured traffic after approval. Use it only on systems where you have
> explicit authorization.

Anti-goals it explicitly fights: hallucinated findings (every `confirm_finding` should be
backed by reproduction evidence), weak context retention (sessions/compaction/snapshots),
poor tooling (real shell/HTTP/Burp/MCP), and lack of auditability (deterministic local paths).

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  src/cli/index.ts  — parse flags, load config, wire everything up      │
└───────┬──────────────────────────────────────────────────────────────┘
        │ builds & injects
        ▼
┌─────────────────┐   events    ┌──────────────────────────────────────┐
│  Agent (loop)   │◄───────────►│  Ink/React TUI (src/ui/App.tsx)       │
│  src/agent/*    │  bridges    │  transcript · modals · menus · banner  │
└───┬──────┬──────┘             └──────────────────────────────────────┘
    │      │
    │      │ calls                ┌──────────────┐
    │      └─────────────────────►│ LLM Client    │ ollama/openai-compat/
    │                             │ src/llm/*     │ kimi/groq/openrouter/
    │                             └──────────────┘ deepseek/gemini/lmstudio
    │ executes (permission-gated)
    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Tool Registry (src/tools/*)                                          │
│  shell · http · file_* · glob/grep · web_* · ask_user ·               │
│  confirm_finding · coverage · load_skill · browser_capture_* · MCP    │
└──────────────────────────────────────────────────────────────────────┘
    │            │            │              │              │
    ▼            ▼            ▼              ▼              ▼
 Skills      Findings    Coverage     Intelligence    Browser/Burp
 registry    store       store        store           capture store
 + SKILL.md  ./findings  coverage-*   scenarios.jsonl  + ingest server
```

The **agent loop runs outside React**. It communicates with the TUI through an event sink
(`AgentEvent`) and two "bridge" objects (permission + ask) that publish requests into React
state to surface modals. The CLI entry point owns the wiring: it constructs the LLM client,
tool registry, skill registry, all the stores, the permission prompter, and then mounts the
Ink app.

**Key dependencies:** `ink` + `react` (TUI), `@modelcontextprotocol/sdk` (MCP), `undici`
(HTTP with custom TLS dispatcher), `zod` (config/schema validation), `zustand` (state stores),
`gray-matter` (SKILL.md frontmatter), `marked`/`marked-terminal`/`cli-highlight` (markdown
rendering), `pino` (logging), `execa` (subprocess), `fast-glob` (search),
`write-file-atomic` (crash-safe writes), `chalk` (colors).

---

## 3. Startup & the CLI entry point

`src/cli/index.ts` is the orchestrator. Its `main()` does, in order:

1. **`forceColor.js` imported first** — sets `FORCE_COLOR` before chalk-consuming modules
   cache their color level.
2. **Parse flags** (`parseFlags`) — see [§15](#15-slash-commands--cli-flags-reference).
3. **`--version` / `--help`** short-circuit and exit.
4. **Init logger**, install **SIGINT/SIGTERM/SIGHUP handlers** that trip a root
   `AbortController` so MCP shutdowns, in-flight HTTP, and tool execs unwind cleanly.
5. **Load config** (`config.load()`); on parse failure the bad file is renamed to
   `config.json.bad-<ts>` and defaults are used. CLI flags override config fields. Provider
   API keys are pulled from env vars (`MOONSHOT_API_KEY`/`KIMI_API_KEY`, `GROQ_API_KEY`,
   `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`) when not set.
6. **Browser MCP handling** — opt-in *per session* via `--browser`, never persisted. Stale
   `browser` entries are stripped from config so it can't auto-enable.
7. **Build the LLM client** via `llmFactory.newFromConfig(cfg)`.
8. **Load skills** — walk built-in + project-local + user dirs (`skillSearchDirs`), apply
   persisted `disabled_skills`.
9. **Create the target**, the permission **bridges/holders**, and the `YoloPrompter`.
10. **Create stores** — `FindingsStore('findings')`, `CaptureStore({maxEntries:5000})`,
    session store (new or `--resume` id), `CoverageStore('findings/coverage-<id>.json')`,
    `IntelligenceStore`. Stale session temp files older than 60s are cleaned up.
11. **Register tools** — see [§6](#6-tools). Includes config-defined command plugins and
    browser-capture tools.
12. **Burp bridge** — `startBurpBridge()` binds the ingest server only when `--burp` is set
    (prints URL + a random hex token to give to the Burp plugin).
13. **Spawn MCP servers in parallel** (`Promise.allSettled` over `discoverMCPTools`), register
    discovered tools.
14. **List-and-exit modes** — `--list-skills` / `--list-tools`.
15. **First-run picker** — if `cfg.tooling_profile === undefined`, show the minimal/full
    tooling picker once and persist the answer.
16. **Construct the `Agent`** with client, tools, skills, prompter, session store, target,
    thinking flag, max steps, compaction threshold, tooling profile, prompt profile,
    intelligence store, streaming flag. If resuming, call `agent.resumeSaved()` and build a
    recap summary.
17. **Live skill reload** — `fs.watch` each loaded skill dir; on change, debounce 250 ms,
    clear + re-walk the registry, re-apply disabled set, `agent.rebuildFromSkills()`, and
    surface a one-line "skills reloaded" notice.
18. **Background probes** (`runProbes`) — (a) tool-calling probe and (b) Ollama `num_ctx`
    detection; both best-effort, feed banner pills/warnings.
19. **Mount the Ink app** (`render(<App .../>)`), wiring publisher bridges, `applyProvider`
    (live `/provider` + `/model` swaps re-probe), `startBurpBridge`, etc.
20. **On exit**, trip the root abort, close watchers, MCP sessions, and the Burp bridge; print
    a `pentesterflow --resume <id>` hint.

**Provider helper functions** in this file map backends to labels, default endpoints, locality
(local vs remote), the effective auto-compact threshold (Groq caps at 5500, Kimi sizes to its
real context window), and the effective prompt profile (Groq + Gemini use `compact`).

---

## 4. The agent loop

Located in `src/agent/`. The `Agent` class implements a **plan → act → observe** cycle.

### Plan / Act / Observe

`Agent.run(userMsg, signal, emit, opts)` is the entry point per turn:

1. **Plan** — auto-compact if token count exceeds threshold; build a **decision plan**
   (`buildDecisionPlan`) that recommends a skill, assigns a risk level, and renders guidance;
   emit a `decision` event; expand `@path` mentions; inject relevant intelligence context.
2. **Act** — loop up to `maxSteps` (default 20): build a `ChatRequest` with history + tool
   specs, call `chat()` or `chatStream()`, strip `<think>` tags, push the assistant message
   into history, emit `assistant-text`/`assistant-delta`.
3. **Observe** — for each tool call: parse args, emit `tool-call`, check the active skill's
   `allowed-tools` policy (`isToolAllowed`), execute via `tools.execute()`, emit `tool-result`
   (with error + duration). `load_skill` calls add to `activeSkills` and emit `skill-active`.
   No tool calls → finish + emit `done`. Step cap exceeded → `MaxStepsError`.

Every iteration checks `signal.aborted`. A `makeSafeEmit()` wrapper swallows emit errors and
suppresses non-terminal events after abort, so a frozen/crashed UI can't wedge the agent.

### Streaming vs non-streaming

Controlled by `streamingEnabled` and `isStreaming(client)`. Streaming emits `assistant-delta`
events for live rendering; non-streaming (the `--no-stream` fallback) is a workaround for
backends whose SSE path drops `tool_calls` mid-stream.

### System prompt (`systemPrompt.ts`)

`buildSystemPrompt(opts)` composes a base prompt from two axes:

- **Prompt profile** — `full` (~8k tokens: full OWASP Top 10 / API Top 10 / LLM Top 10
  checklists, bug-bounty workflow discipline, creative-hunter mindset, tech-stack exploit
  chains, PortSwigger anchors) vs `compact` (~2k tokens, used for small-TPM providers like
  Groq/Gemini).
- **Tooling profile** — `minimal` (curl-first, scanners banned by default) vs `full`
  (authorizes ffuf/nuclei/sqlmap/etc. when workload fits).

It also appends, dynamically: thinking guidance (if enabled), the engagement scope section (if
a target is set), and the **enabled** skills' descriptions (disabled skills are hidden). The
prompt is rebuilt on profile/skill/target changes and on live skill reload.

### Compaction & memory

- **Manual `/compact`** (`Agent.compact`) sends the history (credentials redacted, capped at
  ~22k chars) to the LLM with a structured-summary prompt using fixed headings (Current
  objective, Target and scope, Decisions and assumptions, Tested surface, Findings and
  evidence, Files and commands, Credentials and placeholders, Open TODOs, Next best actions).
  History is replaced with `[system_prompt, user_msg_with_summary]`; `learnIntelligence()` runs.
- **Auto-compaction** (`autoCompact`) triggers before a user message when token count exceeds
  `autoCompactThreshold` (default 16000; 0 disables). A **circuit breaker** disables it after
  3 consecutive failures for the rest of the session.
- The summary is parsed (`parseCompactionSummary`) into a `SessionMemory` object
  (`objectives`, `findings`, `tested`, `files`, `commands`, `credentials`, `todos` + metadata),
  merged with dedup and per-section caps (24 items; findings & credentials uncapped; items
  over 240 chars truncated).
- `approxTokens()` estimates tokens as `length/4`.

### Other agent files

- **`decisionPlanner.ts`** — `buildDecisionPlan` scores enabled skills against the user message
  (keyword + name/description matching), computes risk (`high` if the message names
  exploit/rce/sqlmap/nuclei/ffuf/masscan…), builds a checklist, and renders guidance. Returns
  `undefined` for off-topic messages (no skill, normal risk, unknown target, no workflow terms).
- **`events.ts`** — the `AgentEvent` union: `assistant-text`, `assistant-delta`, `tool-call`,
  `tool-result`, `error`, `compact`, `decision`, `skill-active`, `done`, plus the
  `MaxStepsError` class.
- **`mentions.ts`** — `expandFileMentions` inlines `@path` files (≤64 KB, sensitive paths
  refused) into a "# Referenced files" block; also powers UI mention completion (file index
  capped at 5000 files / 1000 dirs / depth 12; skips `.git`/`node_modules`/`dist`/etc.). The
  raw user message (un-expanded) is what gets persisted to the session.
- **`sanitize.ts`** — `stripThinkingTags` removes `<think>…</think>` blocks and dangling
  closing tags emitted by reasoning models (Qwen, DeepSeek-R1, GLM).

### Skill-based tool gating (`isToolAllowed`)

When skills are active, a tool is allowed if: it requires no permission, **or** every relevant
constraint passes union semantics — any active skill that lists the tool in `allowed-tools`
permits it; a skill with no `allowed-tools` inherits all. Tool names are canonicalized
(`shell` ⇄ `BashTool`, `file_write` ⇄ `FileWriteTool`) before comparison. A blocked tool
yields a tool-result error (not a throw) so the model can self-correct.

---

## 5. LLM providers

`src/llm/` abstracts 8 backends behind a small `Client` interface.

### Interfaces (`client.ts`, `types.ts`)

```ts
interface Client {
  name(): string;
  model(): string;
  chat(req: ChatRequest, signal?): Promise<ChatResponse>;
}
interface StreamingClient extends Client { chatStream(req, onDelta, signal?): Promise<ChatResponse>; }
interface Pinger { ping(signal?): Promise<void>; }   // health check for the status bar
```

Messages use `{ role: 'system'|'user'|'assistant'|'tool', content, toolCalls?, toolCallID?,
name? }`. Tool calls carry JSON-encoded `function.arguments` and an optional `provider` field
for vendor extensions (Gemini `thoughtSignature`).

### Factory (`factory.ts`)

`newFromConfig(cfg)` routes the backend through an exhaustive switch (with a `never` check),
applies per-provider defaults, and enforces required fields (API keys, base URLs).

| Backend | Default base URL | Default model | Notes |
|---|---|---|---|
| `ollama` (config value `''`) | `http://localhost:11434` | user | ND-JSON chat, `/api/tags` ping |
| `lmstudio` | `http://localhost:1234/v1` | user | OpenAI client, empty key, stop tokens |
| `openai-compat` | (required) | user | generic OpenAI |
| `kimi` | `https://api.moonshot.ai/v1` | `kimi-k2.6` | temp-locked (k2.7-code/k2.6/k2.5), `max_completion_tokens`, thinking toggle (k2.7-code thinks always-on) |
| `groq` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` | compact prompt, low compaction threshold |
| `openrouter` | `https://openrouter.ai/api/v1` | `openrouter/auto` | extra `HTTP-Referer`/title headers |
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` | |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `models/gemini-3.5-flash` | key as query param, non-streaming |

### Provider implementations

- **`ollama.ts`** — `POST /api/chat`, ND-JSON streaming that accumulates tool calls across
  chunks (the terminal `done:true` chunk often carries empty `tool_calls`); infers tool calls
  from markdown-fenced/raw JSON in content when the model doesn't emit structured calls; 10-min
  timeout; synthesizes call IDs.
- **`openai.ts`** — shared by 6 backends. SSE streaming, accumulates fragmented tool calls by
  index, streams `reasoning_content` to the UI but never re-injects it. LM Studio gets 13 stop
  tokens + template-marker trimming. Kimi gets `thinking:{type:"disabled"}`,
  `max_completion_tokens`, and `temperature` omitted when locked.
- **`gemini.ts`** — `:generateContent?key=…`; maps `tool→function`, `assistant→model`; system
  prompt → `systemInstruction`; tool results → `functionResponse`; uppercases JSON-schema
  `type`; strips Gemini-unsupported schema keywords; preserves `thoughtSignature`.

### Support modules

- **`models.ts`** — `listModels` per-backend (`/api/tags`, `/models`, Gemini `/models?key`),
  with recommended-first ordering.
- **`providers.ts`** — Kimi/Moonshot context windows (k2.7-code/k2.6/k2.5 = 256K), temperature-lock and
  thinking-toggle detection, `kimiAutoCompactThreshold` (75% of window), known model lists.
- **`modelWarnings.ts`** — warns when local models are < 14b or hosted models < 70b (unreliable
  tool calls).
- **`probe.ts`** — `probeToolSupport` (sends a probe tool, checks the model actually emits a
  call; `yes`/`no`/`unknown`); `detectOllamaContextWindow` (reads `num_ctx` from `/api/show`).
- **`errors.ts`** — `BackendError` + `classifyBackend` → `model-not-loaded` / `model-not-found`
  / `backend-down` / `unknown`.
- **`ids.ts`** — `newCallID()` → `call_<hex>` (random) with a sequential fallback.

---

## 6. Tools

`src/tools/`. Every tool implements `name()`, `description()`, `schema()` (JSON Schema),
`requiresPermission()`, `run(args, signal, prompter)`, and optional `summarize()` /
`permissionHints()`. The **`Registry`** maps names → tools, exposes them as LLM function specs,
and runs the permission gate before `run()`.

| Tool(s) | Permission | Purpose & key safety |
|---|---|---|
| `shell` / `BashTool` | **yes** | Run `/bin/sh`(or bash) `-c`. Denylist (`rm -rf /`, fork bombs, `mkfs`, `dd of=/dev/…`, `shutdown`/`reboot`, `find -delete/-exec rm`); blocks GNU-only flags for macOS/BSD portability; rewrites `grep -P`→`perl -ne`; 5-min default / 30-min max timeout; 32 KB output cap; cache key = (rewritten) command. |
| `http` | **yes** | One request via undici (TLS verify off). Absolute or target-relative URL; 256 KB body cap; 60s timeout; no redirects; **cache key = origin** (scheme+host+port); **SSRF gate** for private hosts. |
| `file_read` / `FileReadTool` | no* | Read UTF-8 (200 KB cap). *Sensitive paths gated inline (symlink-aware). |
| `file_write` / `FileWriteTool` | **yes** | Write/create (mode 0644). Cache key = resolved path; sensitive-path gate. |
| `file_edit` / `FileEditTool` | **yes** | Exact-string replace (`replace_all` opt); sensitive-path gate. |
| `GlobTool` | no* | `fast-glob` discovery; skips `node_modules`/`.git`/`dist`/etc.; no symlinks; sensitive-path gate on base dir. |
| `GrepTool` | no* | Regex content search; glob filter; 5 MB file cap; 200-match default; sensitive-path gate per file. |
| `web_fetch` | no | Fetch + strip HTML (40 KB text cap, 30s); **SSRF gate** (`noSessionCache`). |
| `web_search` | no | DuckDuckGo HTML endpoint, unwraps DDG redirect links, top 10 results. |
| `ask_user` | no | Multi-choice question (2–8 options); auto-injects an "Authorized testing" option when scope-related. |
| `confirm_finding` | no | Persist a **confirmed** finding to `./findings/<slug>.md`; also pushes a Burp issue. Fields: title, severity (critical/high/medium/low/info), url, impact (+ method/param/payload/response_excerpt/curl/remediation). |
| `coverage` | no | Track `(endpoint, param, vuln_class)` tuples; actions `mark`/`list`/`untested`/`summary`/`clear`; persisted to `findings/coverage-<id>.json`. |
| `load_skill` | no | Materialize a skill playbook into context. |
| `read_payloads` | no | Read curated payload lists shipped with skills (`<skill>/payloads/…`); `../` escape blocked. |
| `read_skill_file` | no | Read any auxiliary file in a skill dir (scripts/templates/data). |
| `browser_capture_*` | no (except `_clear`) | Query captured traffic — `status`, `endpoints`, `requests`, `get`, `snapshot`, `burp_tasks`, `burp_issues`, `clear`. |
| MCP tools | **yes** | Discovered from MCP servers, wrapped as `mcp_<server>_<tool>` (128 KB result cap). |
| Command plugins | configurable | External binary; JSON args on stdin; 5-min timeout, 128 KB cap. |

\* "no" tools still apply an **inline sensitive-path gate** when touching protected files.

**SSRF/private-host protection** (`privateHost.ts`) — shared by `http` and `web_fetch`.
`gatePrivateRequest()` prompts with `noSessionCache:true` when a host (literal or DNS-resolved)
falls in loopback / RFC1918 / link-local-metadata (169.254) / IPv6 ULA·link-local·mapped
ranges, or localhost names.

**Sensitive paths** (`sensitive.ts`) — `/etc/shadow`, `/etc/sudoers`, `master.passwd`, and
home-relative `.ssh`, `.aws`, `.gnupg`, `.gcloud`, `.kube`, `.docker`, `.config/gcloud`,
`.config/op`, `.netrc`, `.pgpass`, `.npmrc`, `.pypirc`, `.pentesterflow`, and shell/REPL
histories (`.bash_history`, `.zsh_history`, `.python_history`, `.mysql_history`,
`.psql_history`). Checked by exact match **or** directory prefix (so `.ssh_other` does *not*
match `.ssh`), against both lexical and symlink-resolved real paths.

**Other tool files:** `aliases.ts` (canonical name mapping + `KNOWN_TOOL_NAMES` validation),
`toolDisplay.ts` (friendly labels, primary-arg extraction, compact result views),
`mcpServers.ts` (browser-MCP opt-in filtering — `npx -y @browsermcp/mcp@latest`).

---

## 7. Permission & security model

- **Human-in-the-loop by default.** Permission-gated tools prompt the analyst with
  **allow once / allow session / deny** (`Decision` type). Requests carry
  `{ tool, summary, detail, cacheKey?, noSessionCache? }`.
- **Scoped session caching.** "Allow session" caches on `(tool, cacheKey)` — approving `curl`
  to one host doesn't license another; approving one shell command doesn't license the next.
  `noSessionCache:true` (SSRF, sensitive paths, `browser_capture_clear`) forces a re-prompt
  every time.
- **YOLO mode** (`--yolo` / `--dangerously-skip-permissions` / `/yolo on`) — `YoloPrompter`
  auto-approves all prompts to `allow-once`. The shell **denylist still hard-blocks**
  catastrophic commands regardless. A stderr + amber "SuperMode" badge warns the user.
- **Defense in depth:** shell denylist + portability guard, SSRF gate, sensitive-path gate
  (symlink-proof), TLS-off only inside the HTTP tool, capture server bound to `127.0.0.1` with
  a timing-safe token and chrome-extension CORS.
- **Credential redaction** before compaction, snapshots, and learning (see §14).
- **Auditability:** sessions, JSON-lines logs, findings, coverage all written to deterministic
  local paths.

---

## 8. Skills system

`src/skills/`. Skills are **Markdown playbooks** (`<dir>/SKILL.md`) with gray-matter
frontmatter:

```yaml
---
name: webvuln            # required, ≤64 chars, must match dir name
description: ...         # required, ≤1024 chars — tells the agent when to load it
allowed-tools:           # optional (alias: tools) — restricts which tools the skill may call
  - shell
  - http
disable-model-invocation: false   # optional — true = only reachable via /skillname
---
# markdown body … (supports ${SKILL_DIR} placeholder)
```

**Discovery order** (later wins on name collision):

1. Built-in `skills/` (shipped)
2. Project-local `./.pentesterflow/skills/`
3. `~/.pentesterflow/builtin-skills/` (installer-managed)
4. Personal `~/.pentesterflow/skills/`
5. `--skills <dirs>` / config `skills_dirs`

Dotfiles and `_`-prefixed dirs (e.g. `_template/`) are skipped. The `Registry` tracks
enabled/disabled state (persisted as `disabled_skills`); disabled skills stay listed (`[off]`)
but are hidden from the system prompt and refused by `load_skill`. `LoadSkillTool` validates +
materializes a skill's body. Live reload re-walks dirs on file change.

**Built-in skills:** `recon`, `webvuln`, `ssrf`, `ssti`, `jwt`, `graphql`, `race`, `takeover`,
`supabase`, `deserialize` (+ `_template` scaffold and a `README.md`). Each packages methodology,
payloads, constraints, and curl-first discipline ("real PoC + concrete impact, no theoretical
bugs"). Supporting files: `discovery.ts`, `loadSkill.ts`, `registry.ts`, `template.ts`
(scaffolding for `/skills new`), `validate.ts` (frontmatter validation + conformance tests).

---

## 9. Memory, sessions & continuous learning

### Sessions (`src/session/store.ts`)

Saved to `~/.pentesterflow/sessions/<uuid>.json`:

```jsonc
{
  "updated_at": "ISO", "id": "uuid",
  "target": { "baseURL": "...", "name": "..." } | null,
  "memory": { "version":1, "compactions":N, "objectives":[], "findings":[],
              "tested":[], "files":[], "commands":[], "credentials":[], "todos":[],
              "lastSummary":"...", "lastCompactedAt":"..." } | null,
  "messages": [ { "role","content","toolCalls?","toolCallID?","name?" } ]
}
```

Crash-safe atomic writes (`*.tmp.<hex>` → fsync → rename); stale temps > 1 min cleaned at
startup; corrupt files skipped on listing. `--resume <id>` reloads messages/target/memory and
shows a recap. 5-minute automatic context snapshots go to `~/.pentesterflow/context/*.md`
(redacted).

### Continuous learning (`src/intelligence/store.ts`)

A local **Continuous Learning System** that improves future sessions with no retraining.
Scenarios stored as JSONL:

- **Project scope:** `./.pentesterflow/intelligence/scenarios.jsonl`
- **Personal scope:** `~/.pentesterflow/intelligence/scenarios.jsonl`
- Plus a small hardcoded builtin seed.

Each `IntelligenceScenario` = `{ id, title, category, triggers[], technologies[], lesson,
recommendedChecks[], avoidMissing[], source, createdAt, confidence(0–1), scope }`.

- **Learning** runs in the background after turns/compactions. `learnFromText` redacts secrets,
  then extracts scenarios keyed off the compaction headings (preferences→0.82,
  decisions→0.74, proven-workflows→0.76, lessons→0.8, tool-config→0.73, next-steps→0.72,
  finding-patterns→0.78, coverage-gaps→0.7), detects technologies (Node/Express/PM2/nginx/
  PostgreSQL/GraphQL/WordPress/Supabase/AWS), and extracts triggers (filenames, URLs, vuln
  keywords). Saved to both scopes.
- **Retrieval** (`search`) tokenizes the query, scores scenarios by weighted field
  (triggers 8×, title 7×, technology 6×, category/checks 5×, avoidMissing 4×, lesson 2× +
  confidence bonus), returns top 5, formats as a hidden system-context block.
- **Dedup** by id or `(normalizeKey(title), normalizeKey(category))`. Failures are logged, not
  surfaced as task errors.

---

## 10. Coverage & findings

**Coverage** (`src/coverage/store.ts`) — `findings/coverage-<session>.json`, a deduped matrix
of `CoverageEntry { endpoint(METHOD path), param, vulnClass, status, count, firstSeen,
lastSeen, notes? }`. Statuses: `tried | passed | failed | waf-blocked | skipped`. `untested()`
crosses candidates × vuln classes for `/next`-style suggestions. Persists as
`{version:1, entries:[...]}`.

**Findings** (`src/findings/store.ts`) — `./findings/<slug>.md`. `Finding { title, severity,
url, parameter?, payload?, method?, responseExcerpt?, impact, curl?, remediation?, createdAt,
slug }`. Slugs normalize the title (≤64 chars), de-collide with `-2`, `-3`. Rendered with
heading + impact/payload/evidence/repro-curl/remediation sections.
`httpRequest.ts` converts findings/curl into raw HTTP/1.1 requests (`findingRequestForBurp`,
`httpRequestFromCurl`) for Burp issue import.

---

## 11. Browser / Burp capture & MCP

`src/browser/`. An in-memory `CaptureStore` (bounded, default 5000 entries) holds:

- **`CapturedRequest`** — method, url, headers, request/response bodies (64 KB cap), timing,
  source (`webRequest`/`fetch`/`xhr`/`ws`), `receivedAt`.
- **`EndpointSummary`** — method + path-without-query + query/body param names + hit counts.
- **`SessionSnapshot`** — page URL, cookies (incl. HttpOnly), localStorage, sessionStorage,
  `document.cookie` (for building authenticated requests).
- **`BurpTask`** / **`BurpIssue`** — bounded arrays (1000 each).

**Ingest server** (`server.ts`) — binds `127.0.0.1` only; auth via timing-safe
`X-Pentesterflow-Token`; CORS limited to `chrome-extension://`; endpoints
`POST /ingest|/snapshot|/burp/task|/burp/issues`, `GET /status|/endpoints|/requests|/burp/*`,
`DELETE /clear`; 4 MiB body cap. Started by `--burp [port]` (default 9999) or `/burp`.

**Standalone MCP server** (`mcpServer.ts` → `pentesterflow-browser-mcp` binary) exposes the same
capture data to any MCP client (`--port`, `--max-entries`, `--log`). The companion **Burp
plugin** lives in `burp-plugin/pentesterflow_burp.py`: send selected Burp requests into the CLI,
queue scan tasks, and import confirmed findings back into Burp as issues.

---

## 12. Terminal UI (Ink/React)

`src/ui/`. The agent runs outside React; state flows in via the event sink and the perm/ask
bridges.

- **`App.tsx`** — owns global state (`useReducer`), keymap interception (`useInput`), and the
  multi-line input (`useTextField`). Dispatches `handleSlash()` for every slash command.
- **`state.ts`** — the `AppState` reducer: `transcript` entries (user/assistant/tool-call/
  tool-result/system/error/finding/decision), `busy` + `phase`, `apiReady`, `activeSkill`,
  `pendingPerm`/`pendingAsk`/`pendingSkills`, `yolo`, `transcriptFilter`, `runningTool`.
  Handles streaming deltas, collapsible tool output (>16 lines / >1200 chars → Ctrl-O expands),
  and the Ctrl-F filter cycle.
- **`Transcript.tsx`** — finalized entries print once into native scrollback via Ink `<Static>`
  (mouse-wheel reaches full history); the streaming entry renders live separately. Markdown via
  `renderMarkdown()`, with a WeakMap row cache.
- **Input** — `Input.tsx` (renderer) + `useTextField.ts` (cursor/paste/multiline state) +
  `SlashMenu.tsx` (command typeahead, Tab-complete) + `MentionMenu.tsx` (path-aware `@file`
  picker). `menuWindow.ts` provides shared 5-row windowing.
- **Bridges** — `permBridge.ts` (`BridgedPrompter`) and `askBridge.ts` (`BridgedAskPrompter`)
  publish agent requests into React state, mount a modal, and resolve the agent's promise on the
  user's choice.
- **Modals** — `PermissionModal.tsx` (y/a/n with command detail box), `AskModal.tsx`
  (multi-choice), `SecretInputModal.tsx` (masked input), `SkillsModal.tsx` (toggle skills).
- **Chrome** — `Banner.tsx` (one-time launch box: provider/model/endpoint/path + tool-support
  pill), `StatusBar.tsx` (spinner, phase, elapsed clock, model/target, context %, memory count,
  SuperMode badge), `FirstRunPicker.tsx` (minimal vs full tooling).
- **Formatting** — `markdown.ts` (regex inline markdown → ANSI, code highlighting, tables,
  links), `toolResultFormat.ts` (shell/HTTP colorizers, MCP envelope extraction, collapsible
  views), `slashItems.ts` (command catalog + dynamic skill entries).

---

## 13. Configuration & data paths

**Config** `~/.pentesterflow/config.json` (override via `PENTESTERFLOW_CONFIG`). Zod-validated
schema (`ConfigSchema`): `backend` (default `''`), `model`, `base_url`, `api_key`,
`skills_dirs[]`, `disabled_skills[]`, `mcp_servers[]` (`{name, command, args[], env?}`),
`plugins[]` (`{name, command, args[], description, schema?, requires_permission}`),
`session_path`, `thinking_enabled` (false), `streaming_enabled` (true), `max_steps` (0 = use
default), `auto_compact_threshold` (`DEFAULT_AUTO_COMPACT_THRESHOLD` = 16000), `temperature?`
(0–2), `max_tokens?`, `tooling_profile?` (minimal/full). MCP/plugin `command` fields are
refined by `noShellMeta` (reject shell metacharacters — no shell injection via config). Saved
atomically (`O_EXCL` 0600 → fsync → rename); an invalid file is renamed to `*.bad-<ts>` and
defaults are used.

> **Runtime artifacts in the working directory.** A live engagement directory also accumulates
> non-source data the agent produces: `./findings/*.md` + `coverage-*.json`,
> `./.pentesterflow/intelligence/scenarios.jsonl`, and any analyst-created recon/loot folders
> (e.g. `recon/`, `pivot/`). These are *outputs*, not part of the codebase, and are git-ignored
> or treated as engagement data.

| Path | Contents |
|---|---|
| `~/.pentesterflow/config.json` | Backend/model/endpoint/disabled-skill settings |
| `~/.pentesterflow/sessions/*.json` | Saved sessions for `--resume` |
| `~/.pentesterflow/context/*.md` | Redacted context snapshots (5-min auto) |
| `./.pentesterflow/intelligence/scenarios.jsonl` | Project intelligence |
| `~/.pentesterflow/intelligence/scenarios.jsonl` | Personal reusable intelligence |
| `~/.pentesterflow/builtin-skills/<name>/SKILL.md` | Installer-managed shipped skills |
| `~/.pentesterflow/skills/<name>/SKILL.md` | Personal skills |
| `./.pentesterflow/skills/<name>/SKILL.md` | Project-local skills |
| `./findings/<slug>.md` | Confirmed findings |
| `./findings/coverage-<session-id>.json` | Coverage state |
| `~/.pentesterflow/logs/pentesterflow.log` | JSON-lines logs (rotates at 4 MB) |
| `~/.pentesterflow/debug/session-*.jsonl` | Opt-in full session debug logs |

---

## 14. Cross-cutting utilities

- **Redaction** (`src/redact/redact.ts`) — shape-preserving masking for Bearer/Authorization
  tokens, AWS keys (AKIA/ASIA + secret), GitHub (`ghp_`…), Stripe (`sk_live/test_`), OpenAI
  (`sk-`), Google (`AIza`), Slack (`xox*`), JWTs, generic `api_key/secret/password/token=…`,
  Cookie/Set-Cookie, `x-api-key`, and wholesale `-----BEGIN PRIVATE KEY-----` blocks. Mask keeps
  first/last 2 chars.
- **Permission** (`src/permission/permission.ts`) — `Prompter` interface, `Request`/`Decision`
  types, `YoloPrompter`.
- **Logging** (`src/logger/`) — pino JSON-lines to `~/.pentesterflow/logs/pentesterflow.log`
  (4 MB rotation); optional `sessionDebug` JSONL (`--debug-session`).
- **Target** (`src/target/target.ts`) — `{ baseURL, name }` shared by the HTTP tool and system
  prompt; `/target` updates propagate live.
- **Self-update** (`src/update/selfUpdate.ts`) — `/update [version]` runs the GitHub
  `install.sh`/`install.ps1` (5-min timeout); repo via `PENTESTERFLOW_REPO`.
- **Version** (`src/version/version.ts`) — `VERSION` baked at build via tsup
  `define __BUILD_VERSION__` (fallback `dev`).

---

## 15. Slash commands & CLI flags reference

### Slash commands

| Command | Purpose |
|---|---|
| `/help` | Keybindings + command reference |
| `/provider` | Interactive backend + API key + model picker |
| `/model <id>` · `/model list` | Switch / list models |
| `/plan [objective]` | Plan-only turn (no tool execution) |
| `/next [objective]` | Coverage-driven next-test suggestions |
| `/target <url>` | Set/clear the engagement base URL |
| `/compact` | Summarize into persistent memory |
| `/memory` | Show current session memory |
| `/snapshot` | Write a redacted context snapshot now |
| `/burp [port]` | Start the Burp bridge, print URL + token |
| `/skills [enable\|disable\|new <name>]` | Manage / scaffold skills |
| `/maxsteps <n>` | Per-turn tool-call cap |
| `/thinking on\|off` | Toggle visible reasoning guidance |
| `/update [version]` | Install latest/pinned release |
| `/yolo [on\|off]` | Toggle auto-approval (labs) |
| `/reset` | Clear conversation + saved session |
| `/clear` | Clear on-screen transcript only |
| `/<skill-name>` | Load a skill into the next turn |
| `/exit` · `/quit` | Quit |

### CLI flags

`--backend <ollama\|lmstudio\|kimi\|groq\|openrouter\|deepseek\|gemini\|openai-compat>` ·
`--model <id>` · `--base-url <url>` · `--api-key <key>` · `--skills <dirs>` ·
`--resume <session-id>` · `--browser` · `--burp [port]` · `--browser-ingest [port]`
(deprecated alias) · `--no-stream` · `--yolo` / `--dangerously-skip-permissions` ·
`--list-tools` · `--list-skills` · `--log <path>` · `--debug-session` ·
`--debug-session-path <path>` · `--version`/`-v` · `--help`/`-h`.

### Key bindings (TUI)

Enter send · Ctrl-N/Ctrl-J newline · Esc cancel turn / clear input · Ctrl-C quit ·
↑/↓ history or cursor · Ctrl-A/Ctrl-E line home/end · Ctrl-O expand truncated output ·
Ctrl-F cycle transcript filter · mouse-wheel scroll · Tab complete (slash/mention).

---

## 16. Build, test & developer workflow

- **Build:** `tsup` → ESM bundle to `dist/` (`cli.js`, `browser-mcp.js`), Node 20 target,
  version baked in, shebang banner; externals: `react-devtools-core`, `yoga-wasm-web`,
  `bufferutil`, `utf-8-validate`.
- **Type-check:** `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`).
- **Lint/format:** Biome (2-space, 100-col, LF, organize-imports, `useNodejsImportProtocol`).
- **Test:** Vitest (`src/**/*.test.{ts,tsx}`, node env) — **57 test files** including a local
  `testServer.ts`, conformance tests for skills, and `ink-testing-library` UI tests.
- **Scripts:** `npm run dev[:burp]` (tsx), `build`, `test[:watch]`, `typecheck`, `lint[:fix]`,
  and `ci` = typecheck + lint + test + build.
- **CI** (`.github/workflows/ci.yml`): matrix over ubuntu/macos × Node 20/22 running
  typecheck → lint → test → build. `release.yml` builds/publishes binaries.
- **Install:** `install.sh` / `install.ps1` download the standalone binary (Bun baseline
  runtime for older x86_64, no AVX2) and verify the published SHA-256.

---

## 17. Directory map

```
src/
  cli/            index.ts (entry/orchestrator), forceColor.ts
  agent/          agent.ts (loop), systemPrompt.ts, decisionPlanner.ts,
                  events.ts, mentions.ts, sanitize.ts
  llm/            factory.ts, client.ts, types.ts, providers.ts,
                  ollama.ts, openai.ts, gemini.ts, models.ts,
                  modelWarnings.ts, probe.ts, errors.ts, ids.ts, testServer.ts
  tools/          registry.ts, types.ts, shell.ts, http.ts, file.ts,
                  search.ts, web.ts, finding.ts, coverage.ts, ask.ts,
                  mcp.ts, mcpServers.ts, plugin.ts, browserCapture.ts,
                  payloads.ts, skillFile.ts, sensitive.ts, privateHost.ts,
                  aliases.ts, toolDisplay.ts
  ui/             App.tsx, state.ts, Transcript.tsx, Input.tsx, Banner.tsx,
                  StatusBar.tsx, PermissionModal.tsx, AskModal.tsx,
                  SecretInputModal.tsx, SkillsModal.tsx, SlashMenu.tsx,
                  MentionMenu.tsx, FirstRunPicker.tsx, TerminalSize.tsx,
                  permBridge.ts, askBridge.ts, markdown.ts,
                  toolResultFormat.ts, slashItems.ts, useTextField.ts,
                  menuWindow.ts, colorLevel.ts, usePing.ts
  skills/         registry.ts, discovery.ts, loadSkill.ts, template.ts, validate.ts
  session/        store.ts
  coverage/       store.ts
  findings/       store.ts, httpRequest.ts
  intelligence/   store.ts
  browser/        store.ts, server.ts, mcpServer.ts
  config/         config.ts
  redact/         redact.ts, index.ts
  permission/     permission.ts
  logger/         logger.ts, sessionDebug.ts
  target/         target.ts
  update/         selfUpdate.ts
  version/        version.ts
  ask/            ask.ts

skills/           recon webvuln ssrf ssti jwt graphql race takeover
                  supabase deserialize _template README.md
  ask/            ask.ts (AskPrompter interface satisfied by the TUI)

skills/           recon webvuln ssrf ssti jwt graphql race takeover
                  supabase deserialize _template README.md
burp-plugin/      pentesterflow_burp.py + README.md
scripts/          build-binaries.sh (standalone-binary build)
install.sh / install.ps1   standalone-binary installers (verify SHA-256)
assets/logo.png · tsup.config.ts / tsconfig.json / vitest.config.ts / biome.json
.github/workflows/  ci.yml, release.yml
```

---

*Generated from a full read of the codebase. Cross-references: `README.md` (user-facing),
`CHANGELOG.md` (history), `LICENSE` (Apache-2.0).*
