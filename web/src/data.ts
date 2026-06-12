export const STATS = [
  { n: "8", label: "model backends" },
  { n: "10", label: "pentest skills" },
  { n: "0", label: "theoretical findings" },
];

export const PILLARS = [
  {
    idx: "01",
    title: "Analyst control",
    body: "The human approves sensitive actions and decides scope. Allow-once, allow-session, or deny — every gate is yours.",
  },
  {
    idx: "02",
    title: "Transparent execution",
    body: "Curl-first, reproducible commands. Visible tool calls, saved evidence, and audit-friendly JSON-lines logs.",
  },
  {
    idx: "03",
    title: "Operational learning",
    body: "Local project & personal knowledge bases sharpen future sessions — no retraining, no user-facing complexity.",
  },
];

export const LIFECYCLE = [
  { n: 1, title: "Scope", body: "Set target URL, constraints, credentials, and authorization notes." },
  { n: 2, title: "Recon", body: "Discover hosts, endpoints, technologies, files, APIs, and exposed metadata." },
  { n: 3, title: "Enumeration", body: "Map parameters, roles, auth states, and captured browser / Burp traffic." },
  { n: 4, title: "Validation", body: "Reproduce candidate issues with deterministic requests and compare evidence." },
  { n: 5, title: "Coverage", body: "Track tested endpoint / parameter / vuln-class tuples, ask /next for gaps." },
  { n: 6, title: "Reporting", body: "Persist confirmed findings with PoC, evidence, impact, and remediation." },
  { n: 7, title: "Learning", body: "Save reusable lessons silently so future sessions get smarter." },
];

export const CAPABILITIES = [
  { ico: "⟳", title: "Agent loop", body: "Plan → act → observe → verify → report → learn across scoped tasks, capped per turn." },
  { ico: "⌗", title: "Real tooling", body: "Shell, HTTP, file ops, search, browser capture, Burp ingest, MCP, and finding confirmation." },
  { ico: "▤", title: "Skills", body: "Markdown playbooks packing methodology, payloads, constraints, and allowed tools." },
  { ico: "◈", title: "Memory", body: "Session memory, context snapshots, resume recap, and continuous local intelligence." },
  { ico: "✓", title: "Evidence-backed reports", body: "Confirmed findings to ./findings/<slug>.md with PoC, impact, and remediation." },
  { ico: "▦", title: "Coverage tracking", body: "Endpoint / param / vuln-class matrix and /next for untested attack surface." },
];

export const SKILLS = [
  { tag: "recon", body: "Subdomains, fingerprinting, content discovery, attack-surface mapping." },
  { tag: "webvuln", body: "IDOR, broken access control, injection, auth, and session logic." },
  { tag: "ssrf", body: "Filter bypasses, metadata access, internal reachability, blind SSRF." },
  { tag: "ssti", body: "Template-engine fingerprinting and escalation paths." },
  { tag: "jwt", body: "Algorithm confusion, kid abuse, weak secrets, token-validation flaws." },
  { tag: "graphql", body: "Introspection, authorization gaps, batching, depth abuse." },
  { tag: "race", body: "TOCTOU issues, limit bypasses, race-condition verification." },
  { tag: "takeover", body: "Dangling DNS and unclaimed cloud resources." },
  { tag: "supabase", body: "Row-Level Security and anonymous access mistakes." },
  { tag: "deserialize", body: "Unsafe deserialization sinks and gadget-chain testing." },
];

export const PROVIDERS = [
  "Ollama", "LM Studio", "Kimi", "Groq", "OpenRouter", "DeepSeek", "Gemini", "OpenAI-compatible",
];

export const SECURITY = [
  { title: "Human-in-the-loop", body: "Permission-gated tools require allow-once, allow-session, or deny. Scoped session caching never licenses a second host or command." },
  { title: "Shell safeguards", body: "Catastrophic command patterns are hard-blocked before execution — even in YOLO mode for labs." },
  { title: "SSRF & path gates", body: "Private-host requests and sensitive local paths are gated, symlink-proof, and re-prompt every time." },
  { title: "Credential redaction", body: "Compaction, snapshots, and learning paths redact common secret formats before anything is stored." },
  { title: "Transparent evidence", body: "Findings are backed by reproducible requests and observed responses — copy-pasteable, replayable." },
  { title: "Auditability", body: "Sessions, logs, findings, coverage, and artifacts all write to deterministic local paths." },
];
