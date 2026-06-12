// Documentation content for PentesterFlow, derived from the codebase
// (README.md, PROJECT.md, and src/* module structure).

export type Block =
  | { t: "p"; text: string }
  | { t: "h"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "code"; lang?: string; text: string }
  | { t: "note"; text: string }
  | { t: "table"; head: string[]; rows: string[][] };

export type DocPage = {
  slug: string;
  group: string;
  title: string;
  description: string;
  blocks: Block[];
};

const REPO = "https://github.com/PentesterFlow/agent";

export const PAGES: DocPage[] = [
  /* ---------------------------------------------------------------- */
  {
    slug: "installation",
    group: "Getting started",
    title: "Installation",
    description: "Install the standalone binary on macOS, Linux, or Windows.",
    blocks: [
      { t: "p", text: "The installers download the latest standalone binary for your OS and verify the published SHA-256 checksum when available. The x64 builds use Bun's baseline runtime for older x86_64 CPUs and do not require AVX2." },
      { t: "h", text: "macOS / Linux" },
      { t: "code", lang: "sh", text: "curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh | sh" },
      { t: "h", text: "Windows PowerShell" },
      { t: "code", lang: "powershell", text: "irm https://raw.githubusercontent.com/PentesterFlow/agent/main/install.ps1 | iex" },
      { t: "h", text: "Pin a version or install directory" },
      { t: "code", lang: "sh", text: 'PENTESTERFLOW_VERSION=v0.1.6 PENTESTERFLOW_INSTALL_DIR="$HOME/.local/bin" \\\n  sh -c "$(curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh)"' },
      { t: "h", text: "Release artifacts" },
      {
        t: "table",
        head: ["OS", "Assets"],
        rows: [
          ["macOS", "pentesterflow-darwin-arm64, pentesterflow-darwin-x64"],
          ["Linux", "pentesterflow-linux-arm64, pentesterflow-linux-x64"],
          ["Windows", "pentesterflow-windows-x64.exe"],
        ],
      },
      { t: "note", text: "Authorized use only. The agent can run shell commands, make HTTP requests, edit files, and process captured traffic after approval. Use it only on systems where you have explicit authorization." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "quickstart",
    group: "Getting started",
    title: "Quickstart",
    description: "Run your first scoped assessment in a few commands.",
    blocks: [
      { t: "p", text: "Pull a local model with Ollama, launch the CLI, set a target, and describe what you want tested. The agent plans against the scope, loads the right skill, runs permission-gated tools, and writes evidence-backed findings." },
      { t: "code", lang: "sh", text: "# pull a local model, then launch\nollama pull qwen2.5-coder:32b\npentesterflow" },
      { t: "p", text: "Inside the CLI:" },
      { t: "code", lang: "text", text: "/provider\n/target https://app.example.com\nmap the authenticated API surface and test for IDOR" },
      { t: "h", text: "Resume a previous assessment" },
      { t: "code", lang: "sh", text: "pentesterflow --resume <session-id>" },
      { t: "p", text: "On resume, PentesterFlow shows a recap of the previous session's persistent memory so you can continue without manually reconstructing context." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "providers",
    group: "Getting started",
    title: "Model providers",
    description: "Eight LLM backends behind one small client interface.",
    blocks: [
      { t: "p", text: "PentesterFlow abstracts eight backends behind a small Client interface (name/model/chat, with optional streaming and ping health checks). The factory routes the configured backend through an exhaustive switch, applies per-provider defaults, and enforces required fields such as API keys and base URLs." },
      { t: "h", text: "Interactive setup" },
      { t: "code", lang: "text", text: "/provider\n/model list\n/model <id>" },
      { t: "h", text: "Backends & defaults" },
      {
        t: "table",
        head: ["Backend", "Default base URL", "Default model"],
        rows: [
          ["ollama", "http://localhost:11434", "(user)"],
          ["lmstudio", "http://localhost:1234/v1", "(user)"],
          ["openai-compat", "(required)", "(user)"],
          ["kimi", "https://api.moonshot.ai/v1", "kimi-k2.6"],
          ["groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-20b"],
          ["openrouter", "https://openrouter.ai/api/v1", "openrouter/auto"],
          ["deepseek", "https://api.deepseek.com", "deepseek-v4-flash"],
          ["gemini", "https://generativelanguage.googleapis.com/v1beta", "models/gemini-3.5-flash"],
        ],
      },
      { t: "h", text: "CLI examples" },
      { t: "code", lang: "sh", text: "# Ollama\npentesterflow --backend ollama --model qwen2.5-coder:32b\n\n# OpenAI-compatible endpoint\npentesterflow --backend openai-compat \\\n  --base-url https://api.example.com/v1 --api-key sk-...\n\n# Groq\nGROQ_API_KEY=gsk_... pentesterflow --backend groq --model openai/gpt-oss-20b" },
      { t: "ul", items: [
        "Groq sessions use a compact prompt and a lower compaction threshold to avoid on-demand TPM errors.",
        "LM Studio responses are protected with stop tokens and template-marker trimming.",
        "Kimi K2.6/K2.5 lock temperature, use max_completion_tokens, and can disable the reasoning trace.",
        "Model warnings fire when local models are < 14b or hosted models < 70b (unreliable tool calls).",
      ] },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "agent-loop",
    group: "Concepts",
    title: "The agent loop",
    description: "Plan → act → observe, every turn, with the analyst in control.",
    blocks: [
      { t: "p", text: "The Agent class implements a plan → act → observe cycle. Agent.run(userMsg, signal, emit, opts) is the entry point per turn." },
      { t: "ol", items: [
        "Plan — auto-compact if token count exceeds threshold; build a decision plan that recommends a skill, assigns a risk level, and renders guidance; emit a decision event; expand @path mentions; inject relevant intelligence context.",
        "Act — loop up to maxSteps (default 20): build a ChatRequest with history + tool specs, call chat() or chatStream(), strip <think> tags, push the assistant message into history, emit assistant-text / assistant-delta.",
        "Observe — for each tool call: parse args, emit tool-call, check the active skill's allowed-tools policy, execute via tools.execute(), emit tool-result. No tool calls finishes the turn; exceeding the step cap raises MaxStepsError.",
      ] },
      { t: "p", text: "Every iteration checks signal.aborted. A makeSafeEmit() wrapper swallows emit errors and suppresses non-terminal events after abort, so a frozen UI can't wedge the agent." },
      { t: "h", text: "Streaming vs non-streaming" },
      { t: "p", text: "Streaming emits assistant-delta events for live rendering. The --no-stream fallback is a workaround for backends whose SSE path drops tool_calls mid-stream." },
      { t: "h", text: "Decision planner" },
      { t: "p", text: "buildDecisionPlan scores enabled skills against the user message (keyword + name/description matching), computes a risk level (high if the message names exploit/rce/sqlmap/nuclei/ffuf/masscan), builds a checklist, and renders guidance. It returns nothing for off-topic messages." },
      { t: "h", text: "System prompt" },
      { t: "p", text: "buildSystemPrompt composes from two axes — prompt profile (full ~8k tokens with OWASP/API/LLM checklists, or compact ~2k for small-TPM providers like Groq/Gemini) and tooling profile (minimal: curl-first, scanners banned; or full: authorizes ffuf/nuclei/sqlmap when the workload fits). It dynamically appends thinking guidance, the engagement scope, and the enabled skills' descriptions." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "skills",
    group: "Concepts",
    title: "Skills",
    description: "Markdown playbooks that package methodology, payloads, and tool constraints.",
    blocks: [
      { t: "p", text: "Skills are Markdown playbooks (<dir>/SKILL.md) with gray-matter frontmatter. The frontmatter declares the name, a description telling the agent when to load it, optional allowed-tools restrictions, and disable-model-invocation to make a skill reachable only via /skillname." },
      { t: "code", lang: "yaml", text: "---\nname: webvuln            # required, <=64 chars, must match dir name\ndescription: ...         # required, <=1024 chars\nallowed-tools:           # optional (alias: tools)\n  - shell\n  - http\ndisable-model-invocation: false\n---\n# markdown body … (supports ${SKILL_DIR})" },
      { t: "h", text: "Built-in skills" },
      {
        t: "table",
        head: ["Skill", "Focus"],
        rows: [
          ["recon", "Subdomains, fingerprinting, content discovery, attack-surface mapping."],
          ["webvuln", "IDOR, broken access control, injection, auth, and session logic."],
          ["ssrf", "Filter bypasses, metadata access, internal reachability, blind SSRF."],
          ["ssti", "Template-engine fingerprinting and escalation paths."],
          ["jwt", "Algorithm confusion, kid abuse, weak secrets, token-validation flaws."],
          ["graphql", "Introspection, authorization gaps, batching, depth abuse."],
          ["race", "TOCTOU issues, limit bypasses, race-condition verification."],
          ["takeover", "Dangling DNS and unclaimed cloud resources."],
          ["supabase", "Row-Level Security and anonymous access mistakes."],
          ["deserialize", "Unsafe deserialization sinks and gadget-chain testing."],
        ],
      },
      { t: "h", text: "Discovery order" },
      { t: "p", text: "Later entries win on name collision:" },
      { t: "ol", items: [
        "Built-in skills/ (shipped)",
        "Project-local ./.pentesterflow/skills/",
        "~/.pentesterflow/builtin-skills/ (installer-managed)",
        "Personal ~/.pentesterflow/skills/",
        "--skills <dirs> / config skills_dirs",
      ] },
      { t: "p", text: "Dotfiles and _-prefixed dirs (e.g. _template/) are skipped. Disabled skills stay listed ([off]) but are hidden from the system prompt and refused by load_skill. Live reload re-walks dirs on file change. Scaffold a new skill with /skills new <name>." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "writing-a-skill",
    group: "Concepts",
    title: "Writing a skill",
    description: "Author a custom Markdown playbook the agent can load on demand.",
    blocks: [
      { t: "p", text: "A skill is a directory containing a SKILL.md file: gray-matter frontmatter plus a Markdown body of methodology. Frontmatter tells the agent what the skill is and when to load it; the body is the playbook that gets materialized into context when the skill is loaded." },
      { t: "h", text: "1. Scaffold a new skill" },
      { t: "p", text: "The fastest start is the built-in scaffolder, which writes a SKILL.md from the _template and registers it live:" },
      { t: "code", lang: "text", text: "/skills new my-skill" },
      { t: "p", text: "By default it lands in your personal directory ~/.pentesterflow/skills/my-skill/. To keep a skill with an engagement, create it under ./.pentesterflow/skills/ instead. Either way, the directory name must match the frontmatter name." },
      { t: "h", text: "2. Write the frontmatter" },
      { t: "code", lang: "yaml", text: "---\nname: my-skill            # required, <=64 chars, MUST match the directory name\ndescription: >             # required, <=1024 chars\n  One line on what this playbook does, then a \"Use when ...\" clause so the\n  agent knows when to load it. This description is the ONLY thing the model\n  sees until it loads the skill — make the trigger conditions explicit.\nallowed-tools:             # optional (alias: tools) — restricts callable tools\n  - http\n  - shell\n  - file_write\ndisable-model-invocation: false   # optional — true = reachable only via /my-skill\n---" },
      { t: "ul", items: [
        "name — required, ≤64 chars, must equal the directory name. Validation fails otherwise.",
        "description — required, ≤1024 chars. It is the only thing the model sees before loading, so spell out the trigger conditions (\"Use when …\"). There is no separate triggers list.",
        "allowed-tools (alias: tools) — optional. When present, the skill may only call those tools; a skill with no allowed-tools inherits access to all. Gating uses union semantics across active skills.",
        "disable-model-invocation — optional. true makes the skill reachable only when the operator types /my-skill, never auto-selected by the decision planner.",
      ] },
      { t: "h", text: "3. Write the body" },
      { t: "p", text: "Keep it curl-first and copy-pasteable. Default to the http tool and curl; only reach for specialised scanners when the user asks. State the goal and scope up front, then number the steps." },
      { t: "code", lang: "markdown", text: "# my-skill playbook\n\nState the goal in one or two sentences and the scope rules\n(authorized targets only).\n\n## 1. First step\n\n```sh\ncurl -ksS \"https://TARGET/...\"\n```\n\n## Reporting\n\nWhat proves the bug, the concrete impact in one sentence, and\nremediation. When you have a reproduced request/response, call\n`confirm_finding`." },
      { t: "h", text: "4. Bundle payloads & scripts" },
      { t: "p", text: "Auxiliary files live alongside SKILL.md. Reference a curated payload list with read_payloads, and invoke bundled scripts via the ${SKILL_DIR} placeholder, which expands to the skill's directory at load time." },
      { t: "code", lang: "text", text: "my-skill/\n  SKILL.md\n  payloads/list.txt        → read_payloads(skill=\"my-skill\", file=\"list.txt\")\n  scripts/check.sh         → ${SKILL_DIR}/scripts/check.sh https://TARGET" },
      { t: "p", text: "read_payloads and read_skill_file block ../ path escapes, so a skill can only read inside its own directory." },
      { t: "h", text: "5. Discovery & precedence" },
      { t: "p", text: "Skills are discovered from several roots; on a name collision, later entries win. Dotfiles and _-prefixed directories (like _template) are skipped." },
      { t: "ol", items: [
        "Built-in skills/ (shipped)",
        "Project-local ./.pentesterflow/skills/",
        "~/.pentesterflow/builtin-skills/ (installer-managed)",
        "Personal ~/.pentesterflow/skills/",
        "--skills <dirs> / config skills_dirs",
      ] },
      { t: "p", text: "Loaded skill directories are watched: editing a SKILL.md re-walks the registry (debounced) and rebuilds the system prompt, so you can iterate without restarting. Toggle a skill at runtime with /skills enable|disable, and confirm it loaded with --list-skills." },
      { t: "note", text: "New skills should ship a SKILL.md and pass the skill conformance tests (frontmatter validation in validate.ts). Keep the discipline the built-ins follow: real PoC and concrete impact, no theoretical bugs." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "memory-sessions",
    group: "Concepts",
    title: "Memory & sessions",
    description: "Sessions, compaction, snapshots, and continuous local learning.",
    blocks: [
      { t: "p", text: "Sessions are saved to ~/.pentesterflow/sessions/<uuid>.json with crash-safe atomic writes (tmp → fsync → rename). --resume <id> reloads messages, target, and memory and shows a recap. Five-minute automatic context snapshots go to ~/.pentesterflow/context/*.md (redacted)." },
      { t: "h", text: "Compaction" },
      { t: "ul", items: [
        "Manual /compact sends the redacted history to the LLM with a fixed-heading summary prompt (objective, target/scope, decisions, tested surface, findings/evidence, files/commands, credentials, TODOs, next actions); history is replaced with [system_prompt, user_msg_with_summary].",
        "Auto-compaction triggers before a user message when tokens exceed auto_compact_threshold (default 16000; 0 disables). A circuit breaker disables it after 3 consecutive failures for the session.",
        "The summary parses into a SessionMemory object merged with dedup and per-section caps.",
      ] },
      { t: "h", text: "Continuous learning" },
      { t: "p", text: "A local Continuous Learning System improves future sessions with no retraining. Scenarios are stored as JSONL in two scopes — project (./.pentesterflow/intelligence/scenarios.jsonl) and personal (~/.pentesterflow/intelligence/scenarios.jsonl)." },
      { t: "ul", items: [
        "Learning runs in the background after turns/compactions; learnFromText redacts secrets, then extracts scenarios keyed off the compaction headings, detects technologies, and extracts triggers.",
        "Retrieval tokenizes the query, scores scenarios by weighted field (triggers 8×, title 7×, technology 6×, …), returns the top 5, and injects them as a hidden system-context block.",
        "Duplicates are deduped by id or normalized (title, category). Failures are logged, not surfaced as task errors.",
      ] },
      { t: "h", text: "Useful commands" },
      {
        t: "table",
        head: ["Command", "Purpose"],
        rows: [
          ["/compact", "Summarize the current session into persistent memory."],
          ["/memory", "Show current session memory."],
          ["/snapshot", "Write a redacted context snapshot immediately."],
          ["/next [objective]", "Ask for coverage-driven next steps."],
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "coverage-findings",
    group: "Concepts",
    title: "Coverage & findings",
    description: "Track tested surface and persist evidence-backed findings.",
    blocks: [
      { t: "h", text: "Coverage" },
      { t: "p", text: "The coverage store (findings/coverage-<session>.json) is a deduped matrix of CoverageEntry { endpoint (METHOD path), param, vulnClass, status, count, firstSeen, lastSeen, notes? }. Statuses are tried | passed | failed | waf-blocked | skipped. untested() crosses candidates × vuln classes for /next-style suggestions." },
      { t: "h", text: "Findings" },
      { t: "p", text: "confirm_finding writes confirmed issues to ./findings/<slug>.md. Slugs normalize the title (≤64 chars) and de-collide with -2, -3. Each report renders heading + impact / payload / evidence / repro-curl / remediation sections, and can be converted into a raw HTTP/1.1 request for Burp issue import." },
      { t: "p", text: "A Finding carries: title, severity (critical/high/medium/low/info), url, parameter?, payload?, method?, responseExcerpt?, impact, curl?, remediation?, createdAt, and slug." },
      { t: "note", text: "confirm_finding should be used only after reproduction with request/response evidence — real PoC and concrete impact, never theoretical bugs." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "tools",
    group: "Tools & integrations",
    title: "Tools",
    description: "The permission-gated tool registry available to the agent.",
    blocks: [
      { t: "p", text: "Every tool implements name(), description(), schema() (JSON Schema), requiresPermission(), run(args, signal, prompter), and optional summarize() / permissionHints(). The Registry maps names → tools, exposes them as LLM function specs, and runs the permission gate before run()." },
      {
        t: "table",
        head: ["Tool", "Permission", "Purpose"],
        rows: [
          ["shell / BashTool", "yes", "Run /bin/sh -c with a denylist, portability guard, timeout, and 32 KB output cap."],
          ["http", "yes", "One undici request; 256 KB body cap; no redirects; cache key = origin; SSRF gate for private hosts."],
          ["file_read", "no*", "Read UTF-8 (200 KB cap); sensitive paths gated inline."],
          ["file_write / file_edit", "yes", "Write/create or exact-string replace; sensitive-path gate."],
          ["GlobTool / GrepTool", "no*", "Discovery and regex content search; skips node_modules/.git/dist; sensitive-path gate."],
          ["web_fetch", "no", "Fetch + strip HTML (40 KB cap); SSRF gate."],
          ["web_search", "no", "DuckDuckGo HTML endpoint; top 10 results."],
          ["ask_user", "no", "Multi-choice question (2–8 options)."],
          ["confirm_finding", "no", "Persist a confirmed finding to ./findings/<slug>.md and push a Burp issue."],
          ["coverage", "no", "Track (endpoint, param, vuln_class) tuples."],
          ["load_skill", "no", "Materialize a skill playbook into context."],
          ["browser_capture_*", "no†", "Query captured traffic, endpoints, requests, snapshots, Burp tasks/issues."],
          ["MCP tools", "yes", "Discovered from MCP servers, wrapped as mcp_<server>_<tool>."],
        ],
      },
      { t: "p", text: "* \"no\" tools still apply an inline sensitive-path gate when touching protected files.  † except browser_capture_clear." },
      { t: "h", text: "SSRF & private-host protection" },
      { t: "p", text: "gatePrivateRequest() (shared by http and web_fetch) prompts with noSessionCache:true when a host — literal or DNS-resolved — falls in loopback / RFC1918 / link-local-metadata (169.254) / IPv6 ULA·link-local·mapped ranges, or localhost names." },
      { t: "h", text: "Sensitive paths" },
      { t: "p", text: "/etc/shadow, /etc/sudoers, master.passwd, and home-relative .ssh, .aws, .gnupg, .kube, .docker, .netrc, .npmrc, .pentesterflow, and shell/REPL histories are checked by exact match or directory prefix, against both lexical and symlink-resolved real paths." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "burp-mcp",
    group: "Tools & integrations",
    title: "Burp & browser capture (MCP)",
    description: "Send Burp traffic into the CLI and expose capture data over MCP.",
    blocks: [
      { t: "p", text: "pentesterflow --burp starts a local ingest server for captured requests, endpoints, and browser snapshots. The server binds 127.0.0.1 only, authenticates via a timing-safe X-Pentesterflow-Token, limits CORS to chrome-extension://, and caps bodies at 4 MiB. The default listener is http://127.0.0.1:9999." },
      { t: "code", lang: "sh", text: "pentesterflow --burp\npentesterflow --burp 9999\n\n# from source\nnpm run dev -- --burp 9999" },
      { t: "h", text: "What the bridge supports" },
      { t: "ul", items: [
        "Sending selected Burp requests into PentesterFlow.",
        "Queuing requests as scan tasks.",
        "Importing confirmed findings back into Burp issues.",
        "Preserving full raw requests for evidence and replay.",
        "Reading captured requests and issues through browser_capture_* tools.",
      ] },
      { t: "h", text: "Standalone MCP server" },
      { t: "p", text: "The companion pentesterflow-browser-mcp binary exposes the same capture data to any MCP client (--port, --max-entries, --log)." },
      { t: "code", lang: "json", text: '{\n  "mcpServers": {\n    "pentesterflow-browser": {\n      "command": "pentesterflow-browser-mcp",\n      "args": []\n    }\n  }\n}' },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "security-model",
    group: "Security",
    title: "Security model",
    description: "Defense in depth for authorized offensive-security work.",
    blocks: [
      { t: "ul", items: [
        "Authorized use only — built for permitted security work.",
        "Human-in-the-loop by default — permission-gated tools require allow once, allow session, or deny.",
        "Sensitive path protection — high-risk local paths remain gated, symlink-proof.",
        "Shell safeguards — catastrophic command patterns are blocked before execution.",
        "Credential redaction — compaction, snapshots, and learning paths redact common secret formats.",
        "Transparent evidence — findings are backed by reproducible requests and observed responses.",
        "Auditability — sessions, logs, findings, coverage, and release artifacts are written to deterministic local paths.",
      ] },
      { t: "h", text: "Redaction" },
      { t: "p", text: "Shape-preserving masking covers Bearer/Authorization tokens, AWS keys (AKIA/ASIA + secret), GitHub (ghp_…), Stripe (sk_live/test_), OpenAI (sk-), Google (AIza), Slack (xox*), JWTs, generic api_key/secret/password/token=…, Cookie/Set-Cookie, x-api-key, and whole PRIVATE KEY blocks. The mask keeps the first and last two characters." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "permissions",
    group: "Security",
    title: "Permissions & YOLO mode",
    description: "Scoped approvals, session caching, and the lab-only bypass.",
    blocks: [
      { t: "p", text: "Permission-gated tools prompt the analyst with allow once / allow session / deny. Requests carry { tool, summary, detail, cacheKey?, noSessionCache? }." },
      { t: "h", text: "Scoped session caching" },
      { t: "p", text: "\"Allow session\" caches on (tool, cacheKey) — approving curl to one host doesn't license another, and approving one shell command doesn't license the next. noSessionCache:true (SSRF, sensitive paths, browser_capture_clear) forces a re-prompt every time." },
      { t: "h", text: "YOLO mode" },
      { t: "p", text: "--yolo / --dangerously-skip-permissions / /yolo on auto-approve all prompts to allow-once, including the sensitive-file and SSRF/private-host gates. The shell denylist still hard-blocks catastrophic commands regardless. A stderr warning and an amber SuperMode badge in the status bar make the mode obvious." },
      { t: "note", text: "Breaking in 0.2.0: YOLO now skips everything, matching Claude Code's --dangerously-skip-permissions. The earlier bypassYolo carve-out for credential paths was removed." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "slash-commands",
    group: "Reference",
    title: "Slash commands",
    description: "In-CLI commands for providers, scope, memory, and skills.",
    blocks: [
      {
        t: "table",
        head: ["Command", "Description"],
        rows: [
          ["/help", "Show keybindings and command reference."],
          ["/provider", "Pick backend, API key, and model interactively."],
          ["/model <id> · /model list", "Switch or list backend models."],
          ["/plan [objective]", "Plan-only turn without tool execution."],
          ["/next [objective]", "Coverage-driven next-test suggestions."],
          ["/target <url>", "Set or clear the engagement base URL."],
          ["/compact", "Summarize into persistent session memory."],
          ["/memory", "Show current persistent session memory."],
          ["/snapshot", "Write a redacted context snapshot now."],
          ["/burp [port]", "Start the Burp bridge and print its URL + token."],
          ["/skills [enable|disable|new <name>]", "Manage or scaffold skills."],
          ["/maxsteps <n>", "Set the per-turn tool-call cap."],
          ["/thinking on|off", "Toggle visible reasoning guidance."],
          ["/update [version]", "Install the latest or pinned release."],
          ["/yolo [on|off]", "Toggle auto-approval mode for labs."],
          ["/reset", "Clear conversation and saved session state."],
          ["/clear", "Clear only the on-screen transcript."],
          ["/<skill-name>", "Load a skill into the next turn."],
          ["/exit · /quit", "Quit."],
        ],
      },
      { t: "h", text: "Key bindings" },
      { t: "p", text: "Enter send · Ctrl-N/Ctrl-J newline · Esc cancel turn / clear input · Ctrl-C quit · ↑/↓ history or cursor · Ctrl-A/Ctrl-E line home/end · Ctrl-O expand truncated output · Ctrl-F cycle transcript filter · mouse-wheel scroll · Tab complete (slash/mention)." },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "cli-flags",
    group: "Reference",
    title: "Command-line flags",
    description: "Flags accepted by the pentesterflow binary.",
    blocks: [
      {
        t: "table",
        head: ["Flag", "Description"],
        rows: [
          ["--backend <name>", "ollama | lmstudio | kimi | groq | openrouter | deepseek | gemini | openai-compat."],
          ["--model <id>", "Set the model id."],
          ["--base-url <url> / --api-key <key>", "Configure remote or OpenAI-compatible backends."],
          ["--skills <dirs>", "Load extra skill directories."],
          ["--resume <session-id>", "Resume a saved session and show recap."],
          ["--browser", "Enable Browser MCP tools for the current session."],
          ["--burp [port]", "Start the local Burp/PentesterFlow bridge (default 9999)."],
          ["--no-stream", "Disable streaming for providers with SSE/tool-call issues."],
          ["--yolo", "Auto-approve non-sensitive tool calls (alias: --dangerously-skip-permissions)."],
          ["--list-tools / --list-skills", "Print registered tools or discovered skills."],
          ["--log <path>", "Override the JSON-lines log path."],
          ["--debug-session [--debug-session-path <path>]", "Write a full JSON-lines debug session log."],
          ["--version / --help", "Print version or help."],
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    slug: "configuration",
    group: "Reference",
    title: "Configuration & data paths",
    description: "Config schema and the files PentesterFlow reads and writes.",
    blocks: [
      { t: "p", text: "Config lives at ~/.pentesterflow/config.json (override via PENTESTERFLOW_CONFIG). It is Zod-validated and saved atomically (O_EXCL 0600 → fsync → rename); an invalid file is renamed to *.bad-<ts> and defaults are used. MCP/plugin command fields reject shell metacharacters so config can't inject a shell." },
      { t: "h", text: "Key fields" },
      { t: "ul", items: [
        "backend, model, base_url, api_key",
        "skills_dirs[], disabled_skills[]",
        "mcp_servers[] ({name, command, args[], env?}), plugins[]",
        "thinking_enabled (false), streaming_enabled (true)",
        "max_steps (0 = default), auto_compact_threshold (16000)",
        "temperature? (0–2), max_tokens?, tooling_profile? (minimal/full)",
      ] },
      { t: "h", text: "Data paths" },
      {
        t: "table",
        head: ["Path", "Contents"],
        rows: [
          ["~/.pentesterflow/config.json", "Backend/model/endpoint/disabled-skill settings."],
          ["~/.pentesterflow/sessions/*.json", "Saved sessions for --resume."],
          ["~/.pentesterflow/context/*.md", "Redacted context snapshots (5-min auto)."],
          ["./.pentesterflow/intelligence/scenarios.jsonl", "Project intelligence."],
          ["~/.pentesterflow/intelligence/scenarios.jsonl", "Personal reusable intelligence."],
          ["./findings/<slug>.md", "Confirmed findings."],
          ["./findings/coverage-<session-id>.json", "Coverage state."],
          ["~/.pentesterflow/logs/pentesterflow.log", "JSON-lines logs (rotates at 4 MB)."],
          ["~/.pentesterflow/debug/session-*.jsonl", "Opt-in full session debug logs."],
        ],
      },
      { t: "note", text: "Treat debug logs as sensitive — they can contain target data, command output, and copied request material." },
    ],
  },
];

export type NavGroup = { label: string; items: { slug: string; title: string }[] };

export const NAV: NavGroup[] = (() => {
  const order = ["Getting started", "Concepts", "Tools & integrations", "Security", "Reference"];
  return order.map((label) => ({
    label,
    items: PAGES.filter((p) => p.group === label).map((p) => ({ slug: p.slug, title: p.title })),
  }));
})();

export const REPO_URL = REPO;
export const pageBySlug = (slug: string) => PAGES.find((p) => p.slug === slug);
