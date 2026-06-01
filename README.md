<div align="center">

<img src="assets/logo.png" alt="PentesterFlow" width="520" />

### Agentic offensive-security in your terminal, powered by models you control.

PentesterFlow turns a scoped security objective into a tool-using workflow for
recon, vulnerability testing, verification, and report-ready findings.

<br/>

[![build](https://img.shields.io/github/actions/workflow/status/PentesterFlow/agent/ci.yml?branch=main&label=build&logo=github)](https://github.com/PentesterFlow/agent/actions)
[![release](https://img.shields.io/github/v/release/PentesterFlow/agent?include_prereleases&logo=github)](https://github.com/PentesterFlow/agent/releases)
[![node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![license: Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/PentesterFlow/agent?style=social)](https://github.com/PentesterFlow/agent/stargazers)

**[Install](#install) · [Quickstart](#quickstart) · [Core](#core) · [Usage](#usage) · [Skills](#skills) · [Security](#security-model)**

</div>

---

```console
$ pentesterflow
╭────────────────────────────────────────────────╮
│  PentesterFlow                                 │
│  local agent · tools ready · human approved     │
╰────────────────────────────────────────────────╯

› /target https://app.example.com
  target set to https://app.example.com

› test the orders API for broken access control
⏺ Skill webvuln
  ⎿ loaded skill: webvuln
⏺ http GET https://app.example.com/api/v1/orders/1043
  ⎿ 200 OK
⏺ Shell(curl -s -H "Authorization: Bearer $USER_B" https://app.example.com/api/v1/orders/1043)
  ⎿ cross-account response confirmed
⏺ Confirmed Finding (high) IDOR on /api/v1/orders/{id}
  ⎿ written to ./findings/idor-orders.md
```

## Overview

PentesterFlow is an open-source terminal agent for professional penetration
testing, bug bounty work, and security engineering. It connects to local or
OpenAI-compatible LLM backends, plans against a scoped target, asks for approval
before sensitive actions, runs tools, verifies behavior, and writes findings you
can use in a report.

The project is intentionally **local-first** and **curl-first**. It works well
with Ollama, LM Studio, vLLM, llama.cpp servers, and compatible hosted APIs. It
prefers transparent HTTP and shell commands before heavier scanners, so every
step is visible, reproducible, and easy to audit.

> [!WARNING]
> Use PentesterFlow only on systems where you have explicit authorization. The
> agent can run shell commands, make HTTP requests, edit files, and drive browser
> capture tools after approval.

## Core

| Area | What PentesterFlow provides |
|---|---|
| Agent loop | Plan, act, observe, verify, and report across one scoped task. |
| Model backends | Ollama, LM Studio, and OpenAI-compatible APIs. |
| Tooling | Shell/Bash, HTTP, file tools, search, browser capture, MCP, and finding confirmation. |
| Skills | Markdown playbooks for recon, web vulnerabilities, SSRF, SSTI, JWT, GraphQL, race testing, takeover checks, Supabase, and deserialization. |
| Human control | Permission prompts with allow once, allow session, deny, and explicit YOLO mode for labs. |
| Reporting | Confirmed findings saved as Markdown with evidence, impact, PoC, and remediation. |
| Releases | Standalone binaries for macOS, Linux, and Windows published through GitHub Actions. |

## Highlights

- **Local by default**: run against your own model backend with no required cloud account.
- **Modern terminal UI**: compact tool calls, readable shell transcripts, skill summaries, and finding-focused output.
- **Permission-aware execution**: approve each risky action once or for the session.
- **Verified findings only**: the agent should reproduce a bug before using `confirm_finding`.
- **Portable shell guidance**: tool prompts and preflight checks steer commands away from GNU-only flags when they can break on macOS or Linux.
- **Extensible workflows**: add custom skills, MCP servers, and browser-capture producers.

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
PENTESTERFLOW_VERSION=v0.1.0 PENTESTERFLOW_INSTALL_DIR="$HOME/.local/bin" \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/PentesterFlow/agent/main/install.sh)"
```

You can also download binaries directly from
[GitHub Releases](https://github.com/PentesterFlow/agent/releases):

| OS | Assets |
|---|---|
| macOS | `pentesterflow-darwin-arm64`, `pentesterflow-darwin-x64` |
| Linux | `pentesterflow-linux-arm64`, `pentesterflow-linux-x64` |
| Windows | `pentesterflow-windows-x64.exe` |

## Quickstart

```sh
# 1. Pull a capable local model
ollama pull qwen2.5-coder:32b

# 2. Launch PentesterFlow
pentesterflow

# 3. Set scope, then describe the task
#    /target https://app.example.com
#    test the orders API for IDOR and broken access control
```

## Usage

```sh
# Default: local Ollama
pentesterflow

# LM Studio
pentesterflow --backend lmstudio --model qwen2.5-coder-32b-instruct

# OpenAI-compatible endpoint
pentesterflow --backend openai-compat \
  --base-url https://api.example.com/v1 \
  --api-key sk-...

# Enable browser-capture tools for this session
pentesterflow --browser

# Start the local browser-capture ingest server
pentesterflow --browser-ingest

# Auto-approve tool calls for disposable lab environments only
pentesterflow --dangerously-skip-permissions
```

### Command-Line Flags

| Flag | Description |
|---|---|
| `--backend ollama\|lmstudio\|openai-compat` | Select the LLM backend. |
| `--model <id>` | Set the model id. |
| `--base-url <url>` / `--api-key <key>` | Configure an OpenAI-compatible backend. |
| `--skills <dirs>` | Load extra skill directories. |
| `--resume <session-id>` | Resume a saved session. |
| `--browser` | Enable Browser MCP tools for the current session. |
| `--browser-ingest [port]` | Start the local capture ingest server. |
| `--no-stream` | Disable streaming chat for providers with SSE/tool-call issues. |
| `--dangerously-skip-permissions` | Auto-approve non-sensitive tool calls. |
| `--list-tools` / `--list-skills` | Print registered tools or discovered skills. |
| `--log <path>` | Override the JSON-lines log path. |
| `--version` / `--help` | Print version or help. |

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Show keybindings and command reference. |
| `/provider` | Pick a backend and model interactively. |
| `/model <id>` | Switch model. |
| `/target <url>` | Set or clear the engagement base URL. |
| `/skills [enable\|disable\|new <name>]` | Manage skills or scaffold a new skill. |
| `/maxsteps <n>` | Set the per-turn tool-call cap. |
| `/thinking on\|off` | Toggle visible reasoning guidance. |
| `/update [version]` | Fetch the GitHub release installer and install the latest or pinned version. |
| `/yolo [on\|off]` | Toggle auto-approval mode. |
| `/reset` | Clear conversation and saved session state. |
| `/clear` | Clear only the on-screen transcript. |
| `/<skill-name>` | Load a skill into the next turn. |
| `/exit` | Quit. |

## How It Works

1. **Scope**: set a target and constraints before testing.
2. **Plan**: select the relevant methodology or load a skill playbook.
3. **Act**: call approved tools such as `http`, `shell`, file tools, browser capture, or MCP servers.
4. **Observe**: compare responses, status codes, headers, timing, and account boundaries.
5. **Verify**: reproduce the issue with a clean command or request.
6. **Report**: persist confirmed issues through `confirm_finding`.

## Tools

| Tool | Purpose |
|---|---|
| `shell` / `BashTool` | Run shell commands with approval and safety checks. |
| `http` | Send HTTP/HTTPS requests against full URLs or the active `/target`. |
| `file_read` / `file_write` / `file_edit` | Read, create, and patch files. |
| `GlobTool` / `GrepTool` | Discover files and search content. |
| `web_fetch` / `web_search` | Fetch pages or run web searches. |
| `ask_user` | Ask for a decision when scope or testing direction is ambiguous. |
| `confirm_finding` | Save a verified finding to `./findings/<slug>.md`. |
| `coverage` | Track tested endpoints, parameters, and vulnerability classes. |
| `load_skill` | Load a methodology playbook into context. |
| `browser_capture_*` | Query captured browser traffic, requests, endpoints, and snapshots. |

## Skills

Skills are versioned Markdown playbooks that package methodology, payloads, and
decision logic. Built-in skills include:

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

Discovery order is built-in `skills/`, project-local
`./.pentesterflow/skills/`, personal `~/.pentesterflow/skills/`, then any
directory passed with `--skills`. Later entries win on name collisions.

## Browser Capture

`pentesterflow --browser-ingest` starts a local ingest server on
`127.0.0.1:9999` for captured requests and snapshots. The companion
`pentesterflow-browser-mcp` binary exposes the same capture data as an MCP
server for compatible clients.

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

## Security Model

- **Authorized use only**: PentesterFlow is built for permitted security work.
- **Human approval**: permission-gated tools require allow once, allow session, or deny.
- **Sensitive path protection**: secrets and high-risk local paths stay gated even in YOLO mode.
- **Shell safeguards**: catastrophic commands are blocked before execution.
- **Transcript control**: compacting and export paths redact common credential formats.
- **Transparent evidence**: findings should include the request, response signal, impact, and remediation.

## Configuration And Data

| Path | Contents |
|---|---|
| `~/.pentesterflow/config.json` | Backend, model, endpoint, and disabled-skill settings. |
| `~/.pentesterflow/sessions/*.json` | Saved sessions for `--resume`. |
| `~/.pentesterflow/builtin-skills/<name>/SKILL.md` | Installer-managed shipped skills. |
| `~/.pentesterflow/skills/<name>/SKILL.md` | Personal skills. |
| `./.pentesterflow/skills/<name>/SKILL.md` | Project-local skills. |
| `./findings/<slug>.md` | Confirmed findings for the current engagement. |
| `~/.pentesterflow/logs/pentesterflow.log` | Structured JSON-lines logs. |

## Develop

```sh
npm install
npm run dev -- --version
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
