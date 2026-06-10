<div align="center">

<img src="assets/logo.png" alt="PentesterFlow" width="520" />

### Human-in-the-loop Agentic AI CLI for penetration testers and bug hunters.

PentesterFlow helps security engineers move through recon, enumeration,
validation, evidence collection, and reporting while keeping the analyst in
control.

<br/>

[![build](https://img.shields.io/github/actions/workflow/status/PentesterFlow/agent/ci.yml?branch=main&label=build&logo=github)](https://github.com/PentesterFlow/agent/actions)
[![release](https://img.shields.io/github/v/release/PentesterFlow/agent?include_prereleases&logo=github)](https://github.com/PentesterFlow/agent/releases)
[![node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![license: Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/PentesterFlow/agent?style=social)](https://github.com/PentesterFlow/agent/stargazers)

**[Install](#install) · [Quickstart](#quickstart) · [Lifecycle](#pentest-lifecycle) · [Memory](#continuous-learning) · [Burp](#burp-integration) · [Security](#security-model)**

</div>

---

```console
$ pentesterflow
╭────────────────────────────────────────────────╮
│  PentesterFlow                                 │
│  local agent · tools ready · analyst approved  │
╰────────────────────────────────────────────────╯

› /target https://app.example.com
  target set to https://app.example.com

› test the orders API for broken access control
⏺ Skill webvuln
  ⎿ loaded skill: webvuln
⏺ http GET https://app.example.com/api/v1/orders/1043
  ⎿ 200 OK
⏺ BashTool(curl -s -H "Authorization: Bearer $USER_B" ...)
  ⎿ cross-account response confirmed
⏺ Confirmed Finding (high) IDOR on /api/v1/orders/{id}
  ⎿ written to ./findings/idor-orders.md
```

## Overview

PentesterFlow is an open-source terminal assistant designed specifically for
authorized offensive-security work. It connects to local or hosted LLMs, plans
against a scoped target, uses real pentesting tools, asks for approval before
sensitive actions, remembers useful lessons across sessions, and writes
evidence-backed findings.

It is built around three ideas:

- **Analyst control**: the human approves sensitive actions and decides scope.
- **Transparent execution**: curl-first, reproducible commands, visible tool
  calls, saved evidence, and audit-friendly logs.
- **Operational learning**: local project and personal knowledge bases improve
  future sessions without retraining the model or adding user-facing complexity.

> [!WARNING]
> Use PentesterFlow only on systems where you have explicit authorization. The
> agent can run shell commands, make HTTP requests, edit files, and process
> captured traffic after approval.

## Why PentesterFlow

Current agentic AI systems often struggle with security-specific workflows,
hallucinated findings, weak context retention, poor tool integration, and limited
auditability. PentesterFlow addresses those gaps with:

| Challenge | PentesterFlow approach |
|---|---|
| Generic AI workflows | Built-in pentest skills for recon, web vulns, SSRF, SSTI, JWT, GraphQL, race, takeover, Supabase, and deserialization. |
| Hallucinated findings | `confirm_finding` should be used only after reproduction with request/response evidence. |
| Long engagements | Saved sessions, compaction, context snapshots, resume recap, and continuous local learning. |
| Real-world tooling | Shell/Bash, HTTP, Burp bridge, browser capture, MCP, file tools, grep/glob, and custom plugins. |
| Human oversight | Permission prompts, allow-once/session decisions, and explicit YOLO mode for labs. |
| Reproducibility | Copy-pasteable commands, Markdown findings, JSON-lines logs, and stable session files. |
| Large attack surfaces | Coverage tracking, `/next`, skills, captured traffic queries, and learned coverage gaps. |

## Core Capabilities

| Area | What it provides |
|---|---|
| Agent loop | Plan, act, observe, verify, report, and learn across scoped tasks. |
| Model backends | Ollama, LM Studio, Kimi, Groq, Gemini, and OpenAI-compatible APIs. |
| Tools | Shell/Bash, HTTP, file tools, search, browser capture, Burp ingest, MCP, and finding confirmation. |
| Skills | Markdown playbooks with methodology, payloads, constraints, and allowed tools. |
| Memory | Session memory, context snapshots, resume recap, and continuous local intelligence. |
| Reporting | Confirmed findings saved to `./findings/<slug>.md` with evidence, impact, PoC, and remediation. |
| UX | Full-width terminal UI, slash commands, compact transcripts, permission modals, and interactive provider/model setup. |

## Install

The installers download the latest standalone binary for your OS and verify the
published SHA-256 checksum when available.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/PentesterFlow/agent/main/install.ps1 | iex
```

Pin a release or choose an install directory:

```sh
PENTESTERFLOW_VERSION=v0.1.6 PENTESTERFLOW_INSTALL_DIR="$HOME/.local/bin" \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh)"
```

Download binaries directly from
[GitHub Releases](https://github.com/PentesterFlow/agent/releases):

| OS | Assets |
|---|---|
| macOS | `pentesterflow-darwin-arm64`, `pentesterflow-darwin-x64` |
| Linux | `pentesterflow-linux-arm64`, `pentesterflow-linux-x64` |
| Windows | `pentesterflow-windows-x64.exe` |

The x64 standalone binaries are built with Bun's baseline runtime for older
x86_64 CPUs. They do not require AVX2.

## Quickstart

```sh
# Local model example
ollama pull qwen2.5-coder:32b
pentesterflow
```

Inside the CLI:

```text
/provider
/target https://app.example.com
map the authenticated API surface and test for IDOR
```

Resume a previous assessment:

```sh
pentesterflow --resume <session-id>
```

On resume, PentesterFlow automatically shows a recap of the previous session's
persistent memory so you can continue without manually reconstructing context.

## Providers

Interactive setup:

```text
/provider
/model list
/model <id>
```

CLI examples:

```sh
# Ollama
pentesterflow --backend ollama --model qwen2.5-coder:32b

# LM Studio
pentesterflow --backend lmstudio --model zai-org/glm-4.7-flash

# OpenAI-compatible endpoint
pentesterflow --backend openai-compat \
  --base-url https://api.example.com/v1 \
  --api-key sk-...

# Kimi
MOONSHOT_API_KEY=sk-... pentesterflow --backend kimi --model kimi-k2.6

# Groq
GROQ_API_KEY=gsk_... pentesterflow --backend groq --model openai/gpt-oss-20b

# OpenRouter
OPENROUTER_API_KEY=sk-or-... pentesterflow --backend openrouter --model openrouter/auto

# DeepSeek
DEEPSEEK_API_KEY=sk-... pentesterflow --backend deepseek --model deepseek-v4-flash

# Gemini
GEMINI_API_KEY=AIza... pentesterflow --backend gemini --model models/gemini-3.5-flash
```

Notes:

- Groq sessions use a compact prompt and lower compaction threshold to avoid
  on-demand TPM errors during long assessments.
- LM Studio responses are protected with stop tokens and template-marker
  trimming to avoid repeated `<|user|>` / `<|observation|>` leakage.
- Gemini picker highlights recommended and cheap-cost models.

## Pentest Lifecycle

PentesterFlow is designed to assist across the full engagement:

1. **Scope**: set target URL, constraints, credentials, and authorization notes.
2. **Recon**: discover hosts, endpoints, technologies, files, APIs, and exposed
   metadata.
3. **Enumeration**: map parameters, roles, auth states, captured browser/Burp
   traffic, and attack surfaces.
4. **Validation**: reproduce candidate issues with deterministic requests and
   compare evidence.
5. **Coverage**: track tested endpoint/parameter/vulnerability-class tuples and
   ask `/next` for untested work.
6. **Reporting**: persist confirmed findings with PoC, evidence, impact, and
   remediation.
7. **Learning**: save reusable lessons silently so future sessions improve.

## Continuous Learning

PentesterFlow includes a local Continuous Learning System. It improves future
sessions without retraining model weights and without requiring users to manage
memory manually.

What it stores:

- User preferences and working style.
- Important decisions and project context.
- Successful workflows and proven commands.
- Mistakes, failed assumptions, and lessons learned.
- Coverage gaps, missed checks, and follow-up scenarios.
- Finding patterns and evidence requirements.
- Tool/config patterns that worked well.

Where it stores memory:

| Path | Purpose |
|---|---|
| `./.pentesterflow/intelligence/scenarios.jsonl` | Project-specific intelligence for the current engagement/workspace. |
| `~/.pentesterflow/intelligence/scenarios.jsonl` | Personal reusable intelligence across future projects. |

How it behaves:

- Learning runs in the background after completed turns and compactions.
- Retrieval is silent and injected as hidden context only when relevant.
- Duplicate project/personal memories are deduped before reaching the model.
- Secrets are redacted before storage.
- Learning failures are logged, not shown as user-facing task errors.

This keeps the user experience simple while making the agent more effective over
time.

## Session Memory And Resume

PentesterFlow saves sessions under `~/.pentesterflow/sessions/*.json`.

```sh
ls -lt ~/.pentesterflow/sessions/*.json | head
pentesterflow --resume <session-id>
```

Session continuity includes:

- Saved conversation history.
- Persistent compacted memory.
- Target state.
- Resume recap on startup.
- Context snapshots under `~/.pentesterflow/context/`.
- Five-minute automatic snapshots during active sessions.

Useful commands:

| Command | Purpose |
|---|---|
| `/compact` | Summarize the current session into persistent memory. |
| `/memory` | Show current session memory. |
| `/snapshot` | Write a redacted context snapshot immediately. |
| `/next [objective]` | Ask for coverage-driven next steps. |

## Burp Integration

Use the companion
[PentesterFlow Burp Integration](https://github.com/PentesterFlow/Burp-Integration)
tool to send selected Burp traffic into the CLI and import confirmed findings
back into Burp.

Start the local PentesterFlow listener:

```sh
pentesterflow --burp
pentesterflow --burp 9999
```

From source:

```sh
npm run dev -- --burp 9999
```

The Burp/PentesterFlow bridge supports:

- Sending selected Burp requests into PentesterFlow.
- Queuing requests as scan tasks.
- Importing confirmed findings back into Burp issues.
- Preserving full raw requests for evidence and replay.
- Reading captured requests and issues through `browser_capture_*` tools.

The default listener is `http://127.0.0.1:9999`.

## Browser Capture And MCP

`pentesterflow --burp` starts a local ingest server for captured requests,
endpoints, and browser snapshots. The companion `pentesterflow-browser-mcp`
binary exposes the same capture data as an MCP server for compatible clients.

```json
{
  "mcpServers": {
    "pentesterflow-browser": {
      "command": "pentesterflow-browser-mcp",
      "args": []
    }
  }
}
```

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show keybindings and command reference. |
| `/provider` | Pick backend, API key, and model interactively. |
| `/model <id>` / `/model list` | Switch or list backend models. |
| `/plan [objective]` | Plan-only turn without tool execution. |
| `/next [objective]` | Coverage-driven next test suggestions. |
| `/target <url>` | Set or clear the engagement base URL. |
| `/compact` | Summarize into persistent session memory. |
| `/memory` | Show current persistent session memory. |
| `/snapshot` | Write a redacted context snapshot now. |
| `/burp [port]` | Start the local Burp/PentesterFlow bridge and print its URL + token. |
| `/skills [enable\|disable\|new <name>]` | Manage or scaffold skills. |
| `/maxsteps <n>` | Set the per-turn tool-call cap. |
| `/thinking on\|off` | Toggle visible reasoning guidance. |
| `/update [version]` | Install the latest or pinned release. |
| `/yolo [on\|off]` | Toggle auto-approval mode for labs. |
| `/reset` | Clear conversation and saved session state. |
| `/clear` | Clear only the on-screen transcript. |
| `/<skill-name>` | Load a skill into the next turn. |
| `/exit` | Quit. |

## Command-Line Flags

| Flag | Description |
|---|---|
| `--backend ollama\|lmstudio\|kimi\|groq\|openrouter\|deepseek\|gemini\|openai-compat` | Select the LLM backend. |
| `--model <id>` | Set the model id. |
| `--base-url <url>` / `--api-key <key>` | Configure remote or OpenAI-compatible backends. |
| `--skills <dirs>` | Load extra skill directories. |
| `--resume <session-id>` | Resume a saved session and show recap. |
| `--browser` | Enable Browser MCP tools for the current session. |
| `--burp [port]` | Start the local Burp/PentesterFlow bridge. |
| `--browser-ingest [port]` | Deprecated alias for `--burp`. |
| `--no-stream` | Disable streaming for providers with SSE/tool-call issues. |
| `--yolo` | YOLO mode: auto-approve non-sensitive tool calls (alias: `--dangerously-skip-permissions`). |
| `--list-tools` / `--list-skills` | Print registered tools or discovered skills. |
| `--log <path>` | Override the JSON-lines log path. |
| `--debug-session` | Write a full JSON-lines debug session log. |
| `--debug-session-path <path>` | Write debug session log to a custom path. |
| `--version` / `--help` | Print version or help. |

## Tools

| Tool | Purpose |
|---|---|
| `shell` / `BashTool` | Run shell commands with approval and safety checks. |
| `http` | Send HTTP/HTTPS requests against full URLs or active `/target`. |
| `file_read` / `file_write` / `file_edit` | Read, create, and patch files. |
| `GlobTool` / `GrepTool` | Discover files and search content. |
| `web_fetch` / `web_search` | Fetch pages or run web searches. |
| `ask_user` | Ask for a decision when scope or direction is ambiguous. |
| `confirm_finding` | Save verified findings to `./findings/<slug>.md`. |
| `coverage` | Track tested endpoint/parameter/vulnerability-class tuples. |
| `load_skill` | Load methodology playbooks into context. |
| `browser_capture_*` | Query captured browser/Burp traffic, endpoints, requests, issues, and snapshots. |

## Skills

Skills are Markdown playbooks that package methodology, payloads, and tool
constraints. Built-in skills include:

| Skill | Focus |
|---|---|
| `recon` | Subdomains, fingerprinting, content discovery, and attack-surface mapping. |
| `webvuln` | IDOR, broken access control, injection, auth, and session logic. |
| `ssrf` | Filter bypasses, metadata access, internal reachability, and blind SSRF. |
| `ssti` | Template-engine fingerprinting and escalation paths. |
| `jwt` | Algorithm confusion, `kid` abuse, weak secrets, and token validation flaws. |
| `graphql` | Introspection, authorization gaps, batching, and depth abuse. |
| `race` | TOCTOU issues, limit bypasses, and race-condition verification. |
| `takeover` | Dangling DNS and unclaimed cloud resources. |
| `supabase` | Row-Level Security and anonymous access mistakes. |
| `deserialize` | Unsafe deserialization sinks and gadget-chain testing. |

Discovery order:

1. Built-in `skills/`
2. Project-local `./.pentesterflow/skills/`
3. Personal `~/.pentesterflow/skills/`
4. Directories passed with `--skills`

Later entries win on name collisions.

## Reporting

The `confirm_finding` tool writes confirmed issues to:

```text
./findings/<slug>.md
```

Reports include:

- Title and severity.
- Affected URL, method, parameter, and payload when available.
- Response excerpt proving the issue.
- Impact and remediation.
- Copy-pasteable curl reproduction command.
- Raw request material for Burp issue import when available.

## Security Model

- **Authorized use only**: built for permitted security work.
- **Human-in-the-loop by default**: permission-gated tools require allow once,
  allow session, or deny.
- **Sensitive path protection**: high-risk local paths remain gated.
- **Shell safeguards**: catastrophic command patterns are blocked before
  execution.
- **Credential redaction**: compaction, snapshots, and learning paths redact
  common secret formats.
- **Transparent evidence**: findings should be backed by reproducible requests
  and observed responses.
- **Auditability**: sessions, logs, findings, coverage, and release artifacts are
  written to deterministic local paths.

## Configuration And Data

| Path | Contents |
|---|---|
| `~/.pentesterflow/config.json` | Backend, model, endpoint, and disabled-skill settings. |
| `~/.pentesterflow/sessions/*.json` | Saved sessions for `--resume`. |
| `~/.pentesterflow/context/*.md` | Redacted context snapshots. |
| `./.pentesterflow/intelligence/scenarios.jsonl` | Project intelligence learned from this workspace. |
| `~/.pentesterflow/intelligence/scenarios.jsonl` | Personal reusable intelligence across projects. |
| `~/.pentesterflow/builtin-skills/<name>/SKILL.md` | Installer-managed shipped skills. |
| `~/.pentesterflow/skills/<name>/SKILL.md` | Personal skills. |
| `./.pentesterflow/skills/<name>/SKILL.md` | Project-local skills. |
| `./findings/<slug>.md` | Confirmed findings for the current engagement. |
| `./findings/coverage-<session-id>.json` | Coverage state for endpoint/parameter/vulnerability-class testing. |
| `~/.pentesterflow/logs/pentesterflow.log` | Structured JSON-lines logs. |
| `~/.pentesterflow/debug/session-*.jsonl` | Opt-in full session debug logs. |

Enable complete debug logs when reproducing usage issues:

```sh
pentesterflow --debug-session
PENTESTERFLOW_DEBUG_SESSION=1 pentesterflow
PENTESTERFLOW_DEBUG_SESSION=1 PENTESTERFLOW_DEBUG_SESSION_PATH=/tmp/pf-debug.jsonl pentesterflow
```

Treat debug logs as sensitive because they can contain target data, command
output, and copied request material.

## Develop

```sh
npm install
npm run dev -- --version
npm run dev -- --burp 9999
npm run typecheck
npm run lint
npm run test
npm run build
node dist/cli.js
```

`npm run ci` runs typecheck, lint, tests, and build.

## Contributing

Issues and pull requests are welcome. Keep changes focused, include tests for
behavioral updates, and run `npm run ci` before opening a pull request. New
skills should include a `SKILL.md` and pass the skill conformance tests.

## License

[Apache-2.0](LICENSE). Use responsibly and only with authorization.

<div align="center">
<br/>

**[Report an issue](https://github.com/PentesterFlow/agent/issues)** ·
**[Request a feature](https://github.com/PentesterFlow/agent/issues/new)** ·
**[Releases](https://github.com/PentesterFlow/agent/releases)**

</div>
