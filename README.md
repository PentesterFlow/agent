[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/pentesterflow-agent-badge.png)](https://mseep.ai/app/pentesterflow-agent)

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
PF v0.3.0 · ollama · …/engagement

› /target https://app.example.com
  target set to https://app.example.com

› test the orders API for broken access control
⏺ Skill webvuln · forked
  ⎿ forked webvuln · 4 tools
⏺ http GET https://app.example.com/api/v1/orders/1043
  ⎿ 200 OK
⏺ shell · HTTP request
  $ curl -s -H "Authorization: Bearer $USER_B" ...
  ⎿ cross-account response confirmed
★ (high) IDOR on /api/v1/orders/{id}
  ⎿ written to ./findings/idor-orders.md

Ready · qwen3:14b · app.example.com
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
| Human oversight | Permission tiers (`ask` / `auto-safe` / `yolo`), allow-once/session, plan mode. |
| Reproducibility | Copy-pasteable commands, Markdown findings, JSON-lines logs, and stable session files. |
| Large attack surfaces | Coverage tracking, `/next`, skills, captured traffic queries, and learned coverage gaps. |

## Core Capabilities

| Area | What it provides |
|---|---|
| Agent loop | Plan, act, observe, verify, report, and learn — with auto-continue and context compact. |
| Model backends | Ollama, LM Studio, Kimi, Groq, Gemini, Anthropic, and OpenAI-compatible APIs. |
| Tools | Shell, HTTP, file tools, search, browser capture, Burp ingest, MCP, jobs, findings. |
| Skills | Markdown playbooks; optional `fork` so large playbooks stay out of parent context. |
| Memory | Session memory, curated `#` facts, context snapshots, resume recap, local intelligence. |
| Reporting | Confirmed findings in `./findings/<slug>.md` with evidence, impact, PoC, remediation. |
| UX | OpenTUI full-width chat, slash commands, permission modals, click-to-expand. |

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

# Anthropic
ANTHROPIC_API_KEY=sk-ant-... pentesterflow --backend anthropic --model claude-opus-4-8

# Naraya (multi-vendor OpenAI-compatible router)
NARAYA_API_KEY=sk-nry-... pentesterflow --backend naraya --model deepseek-v4-flash-naraya
```

Notes:

- Groq sessions use a compact prompt and lower compaction threshold to avoid
  on-demand TPM errors during long assessments.
- LM Studio responses are protected with stop tokens and template-marker
  trimming to avoid repeated `<|user|>` / `<|observation|>` leakage.
- Gemini picker highlights recommended and cheap-cost models.

## Supported Providers and Models

PentesterFlow talks to any OpenAI-compatible endpoint plus native Gemini and
Anthropic backends. Use `/provider` to configure interactively, or
`--backend`/`--model` on the CLI. Hosted model lists are fetched live from each
provider; the models below are the curated, recommended-first picks.

| Backend | Default base URL | Default model | Recommended models |
| --- | --- | --- | --- |
| `ollama` | `http://localhost:11434` | _(installed)_ | any local model (e.g. `qwen2.5-coder:32b`); 14b+ recommended for tool use |
| `lmstudio` | `http://localhost:1234/v1` | _(loaded)_ | any loaded model (e.g. `zai-org/glm-4.7-flash`) |
| `openai-compat` | _(required)_ | _(server)_ | whatever the endpoint serves |
| `kimi` | `https://api.moonshot.ai/v1` | `kimi-k2.6` | `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`, `moonshot-v1-{8k,32k,128k}` (+ `-vision-preview`) |
| `groq` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `meta-llama/llama-4-maverick-17b-128e-instruct`, `meta-llama/llama-4-scout-17b-16e-instruct`, `qwen/qwen3-32b`, `deepseek-r1-distill-llama-70b`, `compound-beta`, `compound-beta-mini` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openrouter/auto` | `openrouter/auto` (auto-router) + any OpenRouter model |
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` | `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `models/gemini-3.5-flash` | `models/gemini-3.5-flash`, `models/gemini-3.1-pro-preview`, `models/gemini-flash-latest`, `models/gemini-3-flash-preview`, `models/gemini-3.1-flash-lite`, `models/gemini-2.5-flash-lite`; cheap: `models/gemini-flash-lite-latest`, `models/gemini-3.1-flash-lite-preview`, `models/gemma-4-26b-a4b-it` |
| `anthropic` | `https://api.anthropic.com/v1` | `claude-opus-4-8` | `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-5`, `claude-sonnet-4-5` |
| `naraya` | `https://router.naraya.ai/v1` | `deepseek-v4-flash-naraya` | `deepseek-v4-flash-naraya`, `qwen3.7-max-naraya`, `minimax-m3`, `claude-sonnet-4.5`, `claude-haiku-4.5`, `glm-5`, `deepseek-3.2`, `mistral-large`, `mistral-medium-3-5` |

Model-specific handling:

- **Kimi** `kimi-k2.7-code` / `kimi-k2.6` / `kimi-k2.5` carry a 256K context
  window and lock `temperature` to `1`. `k2.7-code` always reasons (thinking is
  mandatory); `k2.6` / `k2.5` expose a thinking toggle.
- **DeepSeek** `deepseek-chat` / `deepseek-reasoner` are compatibility aliases
  for `deepseek-v4-flash` (non-thinking / thinking) and are slated for
  deprecation on 2026-07-24 — prefer the `deepseek-v4-*` ids.
- **Anthropic** Opus 4.7 / 4.8 reject the `temperature` parameter; older Claude
  models still accept it.
- **Naraya** is a multi-vendor router (DeepSeek, Qwen, GLM, Mistral, MiniMax,
  Claude) behind one OpenAI-compatible endpoint. Inference is served from
  `router.naraya.ai` and naraya's own model ids carry a `-naraya` suffix where
  they differ from upstream (e.g. `deepseek-v4-flash-naraya`); the full catalog
  is fetched live via `/provider`. Several models expose a 1M-token context.
- **Hosted size guidance**: sub-70b hosted models may be unreliable for agentic
  tool calls; 70b+ (or a frontier MoE) is recommended.

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
| `/memory` | Show saved facts + the session checkpoint. |
| `/memory add <text>` | Save a durable fact (same as `#<text>`). |
| `/memory list` | List saved facts. |
| `/memory forget <text>` | Drop saved facts and checkpoint items matching the text. |
| `/snapshot` | Write a redacted context snapshot immediately. |
| `/next [objective]` | Ask for coverage-driven next steps. |

### Saved memory (`#` quick-add)

Type `#` followed by anything you want the agent to remember for the rest of
this session and beyond — for example `#orders API is IDOR-prone on
/api/orders/{id}`. Use `#!<text>` to save it to your **personal** scope instead
of the project.

- Saved facts are durable, human-readable Markdown — one file per fact with
  frontmatter — under `./.pentesterflow/memory/` (project) and
  `~/.pentesterflow/memory/` (personal), with a generated `MEMORY.md` index.
- The fact catalog is pinned into the system prompt on **every** turn, so it
  survives compaction; the facts most relevant to the current turn are recalled
  in full automatically (you'll see a `recalled memory: …` line).
- Secrets are redacted before a fact is written to disk.
- Manage them with `#<text>` / `/memory add`, `/memory list`, and
  `/memory forget <text>`.

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
| `/mode ask\|auto-safe\|yolo\|plan\|act` | Permission tier or plan/act work mode. |
| `/plan [objective]` | Plan-only turn without tool execution. |
| `/next [objective]` | Coverage-driven next test suggestions. |
| `/target <url>` | Set or clear the engagement base URL. |
| `/scope …` | Engagement host allowlist for http/web_fetch. |
| `/compact` | Summarize into persistent session memory. |
| `/memory` | Saved facts, session memory, provider status. |
| `/jobs` | List background shell jobs. |
| `/snapshot` | Write a redacted context snapshot now. |
| `/report [markdown\|sarif]` | Export all confirmed findings. |
| `/burp [port]` | Start the local Burp/PentesterFlow bridge. |
| `/skills [enable\|disable\|new <name>]` | Manage or scaffold skills. |
| `/maxsteps <n>` | Tool budget before quiet auto-continue (default 20). |
| `/thinking on\|off` | Toggle visible reasoning guidance. |
| `/update [version]` | Install the latest or pinned release. |
| `/yolo [on\|off]` | Toggle YOLO auto-approve (lab only). |
| `/reset` | Clear conversation and saved session state. |
| `/clear` | Clear only the on-screen transcript. |
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
| `shell` / `bash` | Run shell commands (optional `background: true` for long jobs). |
| `http` | HTTP/HTTPS against full URLs or active `/target`. |
| `file_read` / `file_write` / `file_edit` | Read, create, and patch files. |
| `glob` / `grep` | Discover files and search content. |
| `web_fetch` / `web_search` | Fetch pages or run web searches. |
| `ask_user` | Ask for a decision when scope or direction is ambiguous. |
| `confirm_finding` | Save verified findings to `./findings/<slug>.md`. |
| `coverage` | Track tested endpoint/parameter/vulnerability-class tuples. |
| `todo` | Live checklist for the engagement plan. |
| `load_skill` | Load playbooks (`fork=true` runs them in a child agent). |
| `delegate_task` | Spawn a short worker/explore sub-agent and return a summary. |
| `background_status` | List / get / kill background shell jobs. |
| `browser_capture_*` | Query captured browser/Burp traffic and snapshots. |

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
  allow session, or deny. Use `/mode auto-safe` for read-only auto-approve, or
  `/yolo` only in labs.
- **Sensitive path protection**: high-risk local paths remain gated.
- **Shell safeguards**: catastrophic command patterns are blocked before
  execution.
- **Credential redaction**: compaction, snapshots, and learning paths redact
  common secret formats.
- **Transparent evidence**: findings should be backed by reproducible requests
  and observed responses.
- **Auditability**: sessions, logs, findings, coverage, and release artifacts are
  written to deterministic local paths.

### Keyboard (OpenTUI)

| Key | Action |
|---|---|
| Enter | Send prompt |
| Esc | Cancel in-flight turn / clear draft |
| Ctrl+O | Expand truncated tool output |
| Cmd+C / Ctrl+Y | Copy selection or last tool/finding output (`pbcopy` on macOS) |
| Cmd+V / Ctrl+V | Paste (`pbpaste` + bracketed paste) |
| PgUp / PgDn / wheel | Scroll chat history |
| Tab | Complete slash command or `@` file mention |

> **macOS Terminal.app:** drag-select text in the app, then **Cmd+C** (or wait for
> auto-copy on mouse-up). **Cmd+V** pastes into the prompt. Apple Terminal ignores
> OSC 52 clipboard escapes — PentesterFlow uses `pbcopy`/`pbpaste` instead.

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
bun install
bun run dev -- --version
bun run dev -- --burp 9999
bun run typecheck
bun run lint
bun run test
bun run build
bun dist/cli.js
```

`bun run ci` runs typecheck, lint, tests, and build.

## Contributing

Issues and pull requests are welcome. Keep changes focused, include tests for
behavioral updates, and run `bun run ci` before opening a pull request. New
skills should include a `SKILL.md` and pass the skill conformance tests.

## License

[Apache-2.0](LICENSE). Use responsibly and only with authorization.

<div align="center">
<br/>

**[Report an issue](https://github.com/PentesterFlow/agent/issues)** ·
**[Request a feature](https://github.com/PentesterFlow/agent/issues/new)** ·
**[Releases](https://github.com/PentesterFlow/agent/releases)**

</div>
