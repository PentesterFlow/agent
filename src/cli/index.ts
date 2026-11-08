// CLI entry: parse flags, load
// config + signal handler, build tools + skills + agent, launch the
// OpenTUI. MCP servers are spawned in parallel and torn down on exit.

// MUST be first — sets FORCE_COLOR before chalk-consuming modules
// (cli-highlight, etc.) cache their color level.
import './forceColor.js';

import { randomBytes } from 'node:crypto';
import { type FSWatcher, existsSync, watch as fsWatch, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import React from 'react';
import { Agent } from '../agent/agent.js';
import { BackgroundTaskManager } from '../agent/backgroundTasks.js';
import type { AgentEvent } from '../agent/events.js';
import type { PromptProfile } from '../agent/systemPrompt.js';
import { type IngestServerHandle, startIngestServer } from '../browser/server.js';
import { CaptureStore } from '../browser/store.js';
import * as config from '../config/config.js';
import { CoverageStore } from '../coverage/store.js';
import { MemoryStore } from '../curatedMemory/store.js';
import { EngagementStore } from '../engagement/store.js';
import { findingRequestForBurp } from '../findings/httpRequest.js';
import { Store as FindingsStore } from '../findings/store.js';
import { runNotifyHooks } from '../hooks/hooks.js';
import { IntelligenceStore } from '../intelligence/store.js';
import * as llmFactory from '../llm/factory.js';
import { modelReliabilityWarning } from '../llm/modelWarnings.js';
import { OllamaClient } from '../llm/ollama.js';
import { detectOllamaContextWindow, probeToolSupport } from '../llm/probe.js';
import { getOpenAISchemeProvider, isOpenAISchemeProvider } from '../llm/providerRegistry.js';
import {
  DAHL_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_BASE_URL,
  GROQ_DEFAULT_BASE_URL,
  KIMI_DEFAULT_BASE_URL,
  NARAYA_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  kimiAutoCompactThreshold,
} from '../llm/providers.js';
import * as logger from '../logger/logger.js';
import { createSessionDebugLog } from '../logger/sessionDebug.js';
import * as memoryProviderFactory from '../memoryProvider/factory.js';
import { YoloPrompter } from '../permission/permission.js';
import * as sessionStore from '../session/store.js';
import { skillSearchDirs } from '../skills/discovery.js';
import { LoadSkillTool } from '../skills/loadSkill.js';
import { Registry as SkillRegistry } from '../skills/registry.js';
import { ScopeStore } from '../target/scope.js';
import { newTarget } from '../target/target.js';
import { AskUserTool } from '../tools/ask.js';
import { BackgroundStatusTool, formatJobsList } from '../tools/backgroundStatus.js';
import { registerBrowserCaptureTools } from '../tools/browserCapture.js';
import { CoverageTool } from '../tools/coverage.js';
import {
  DELEGATE_MAX_STEPS,
  DelegateTool,
  type NoticePayload,
  childProgressNoticeFromEvent,
  isExploreAllowedTool,
  summarizeDelegateEvents,
  wireChildProgress,
} from '../tools/delegate.js';
import {
  FileEditTool,
  FileEditToolAlias,
  FileReadTool,
  FileReadToolAlias,
  FileWriteTool,
  FileWriteToolAlias,
} from '../tools/file.js';
import { ConfirmFindingTool } from '../tools/finding.js';
import { HTTPTool } from '../tools/http.js';
import { type MCPSession, discoverMCPTools } from '../tools/mcp.js';
import { BROWSER_MCP_NAMES, mcpServerFingerprint, sessionMcpServers } from '../tools/mcpServers.js';
import { ReadPayloadsTool } from '../tools/payloads.js';
import { CommandPluginTool } from '../tools/plugin.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import { ScopeTool } from '../tools/scope.js';
import { GlobTool, GrepTool } from '../tools/search.js';
import { BashTool, ShellTool } from '../tools/shell.js';
import { ReadSkillFileTool } from '../tools/skillFile.js';
import { TodoTool } from '../tools/todo.js';
import { UpdateUserProfileTool } from '../tools/userProfile.js';
import { WebFetchTool, WebSearchTool } from '../tools/web.js';
import type { BannerData } from '../ui/Banner.js';
import type { AppProps } from '../ui/appTypes.js';
import { BridgedAskPrompter } from '../ui/askBridge.js';
import { BridgedPrompter } from '../ui/permBridge.js';
import { UserProfileStore } from '../userProfile/store.js';
import { VERSION, describe } from '../version/version.js';

const GROQ_AUTO_COMPACT_THRESHOLD = 5500;

interface ParsedFlags {
  showVersion: boolean;
  showHelp: boolean;
  backend: string;
  model: string;
  baseURL: string;
  apiKey: string;
  skillsDirs: string[];
  resumeID: string;
  yolo: boolean;
  browser: boolean;
  burp: boolean;
  burpPort: number;
  noStream: boolean;
  logPath: string;
  debugSession: boolean;
  debugSessionPath: string;
  listSkills: boolean;
  listTools: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = {
    showVersion: false,
    showHelp: false,
    backend: '',
    model: '',
    baseURL: '',
    apiKey: '',
    skillsDirs: [],
    resumeID: '',
    yolo: false,
    browser: false,
    burp: false,
    burpPort: 9999,
    noStream: false,
    logPath: '',
    debugSession: process.env.PENTESTERFLOW_DEBUG_SESSION === '1',
    debugSessionPath: process.env.PENTESTERFLOW_DEBUG_SESSION_PATH ?? '',
    listSkills: false,
    listTools: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    switch (a) {
      case '--version':
      case '-v':
        out.showVersion = true;
        break;
      case '--help':
      case '-h':
        out.showHelp = true;
        break;
      case '--backend':
        out.backend = next();
        break;
      case '--model':
        out.model = next();
        break;
      case '--base-url':
        out.baseURL = next();
        break;
      case '--api-key':
        out.apiKey = next();
        break;
      case '--skills':
        out.skillsDirs = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--resume':
        out.resumeID = next();
        break;
      case '--yolo':
      // --dangerously-skip-permissions is the original spelling, kept as an
      // alias so existing scripts/docs keep working. Both mean YOLO mode.
      case '--dangerously-skip-permissions':
        out.yolo = true;
        break;
      case '--browser':
        out.browser = true;
        break;
      case '--no-stream':
        out.noStream = true;
        break;
      case '--burp':
      case '--browser-ingest': {
        out.burp = true;
        // Optional inline port: --burp 9999. If the next arg
        // starts with '--' or is missing, fall back to the default.
        const peek = argv[i + 1];
        if (peek && !peek.startsWith('--')) {
          const n = Number.parseInt(peek, 10);
          if (Number.isFinite(n) && n > 0 && n < 65536) {
            out.burpPort = n;
            i += 1;
          }
        }
        break;
      }
      case '--log':
        out.logPath = next();
        break;
      case '--debug-session':
        out.debugSession = true;
        break;
      case '--debug-session-path':
        out.debugSession = true;
        out.debugSessionPath = next();
        break;
      case '--list-skills':
        out.listSkills = true;
        break;
      case '--list-tools':
        out.listTools = true;
        break;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.showVersion) {
    process.stdout.write(`${describe()}\n`);
    return 0;
  }
  if (flags.showHelp) {
    printHelp();
    return 0;
  }

  logger.init(flags.logPath);
  logger.info('startup', { version: VERSION, pid: process.pid });

  // Root abort controller — tripped by SIGINT/SIGTERM/SIGHUP so MCP
  // shutdowns, in-flight HTTP calls, and tool execs unwind cleanly.
  const rootCtl = new AbortController();
  const onSig = (s: NodeJS.Signals) => {
    logger.warn('signal received, shutting down', { signal: s });
    rootCtl.abort();
  };
  process.on('SIGINT', () => onSig('SIGINT'));
  process.on('SIGTERM', () => onSig('SIGTERM'));
  process.on('SIGHUP', () => onSig('SIGHUP'));

  // Config.
  let cfg: config.Config;
  try {
    cfg = config.load();
  } catch (err) {
    const badPath = config.configPath();
    const backupPath = `${badPath}.bad-${Date.now()}`;
    try {
      renameSync(badPath, backupPath);
      process.stderr.write(
        `warning: config was invalid and has been reset to defaults: ${(err as Error).message}
  • your previous config (including any saved API key) is backed up at ${backupPath}
  • reconfigure your backend/key with /provider in the TUI
`,
      );
    } catch {
      process.stderr.write(
        `warning: config was invalid and defaults are in use: ${(err as Error).message}
  • reconfigure your backend/key with /provider in the TUI
`,
      );
    }
    cfg = config.defaultConfig();
  }
  if (flags.backend) {
    const b = flags.backend as config.Config['backend'];
    if (b !== '' && !(config.BACKENDS as readonly string[]).includes(b)) {
      process.stderr.write(
        `Unknown backend "${flags.backend}". Supported: ${config.BACKENDS.join(', ')}\n`,
      );
      return 1;
    }
    cfg = { ...cfg, backend: b };
  }
  if (flags.model) cfg.model = flags.model;
  if (flags.baseURL) cfg.base_url = flags.baseURL;
  // --help documents --api-key as ephemeral (visible to other local users via
  // ps/procfs, "prefer env var or /provider") — it must never get written to
  // disk. cfg.api_key still needs the value for THIS run's LLM client, but
  // the flag-sourced flag is tracked separately so any config.save() below
  // (e.g. the first-run picker, which used to persist whatever was already
  // sitting in cfg.api_key at that point) can exclude it.
  // True once the user has explicitly configured a key to persist (either no
  // --api-key was used, or they later set one through /provider). While
  // false, any config.save(cfg) for an unrelated reason (first-run picker,
  // persisting disabled-skills) must not carry the ephemeral flag-sourced key
  // to disk as a side effect.
  let apiKeyPersistable = !flags.apiKey;
  if (flags.apiKey) cfg.api_key = flags.apiKey;
  const persistConfig = (c: config.Config) =>
    config.save(apiKeyPersistable ? c : { ...c, api_key: '' });
  if (flags.skillsDirs.length) cfg.skills_dirs = [...cfg.skills_dirs, ...flags.skillsDirs];
  if (cfg.backend === 'openai' && !cfg.api_key) {
    cfg.api_key = process.env.OPENAI_API_KEY || '';
  }
  if (cfg.backend === 'kimi' && !cfg.api_key) {
    cfg.api_key = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '';
  }
  if (cfg.backend === 'groq' && !cfg.api_key) {
    cfg.api_key = process.env.GROQ_API_KEY || '';
  }
  if (cfg.backend === 'openrouter' && !cfg.api_key) {
    cfg.api_key = process.env.OPENROUTER_API_KEY || '';
  }
  if (cfg.backend === 'deepseek' && !cfg.api_key) {
    cfg.api_key = process.env.DEEPSEEK_API_KEY || '';
  }
  if (cfg.backend === 'gemini' && !cfg.api_key) {
    cfg.api_key = process.env.GEMINI_API_KEY || '';
  }
  if (cfg.backend === 'anthropic' && !cfg.api_key) {
    cfg.api_key = process.env.ANTHROPIC_API_KEY || '';
  }
  if (cfg.backend === 'naraya' && !cfg.api_key) {
    cfg.api_key = process.env.NARAYA_API_KEY || '';
  }
  if (cfg.backend === 'dahl' && !cfg.api_key) {
    cfg.api_key = process.env.DAHL_API_KEY || '';
  }
  // OpenCode-aligned OpenAI-scheme presets (xai, mistral, togetherai, …)
  if (!cfg.api_key) {
    const preset = getOpenAISchemeProvider(cfg.backend);
    if (preset) {
      for (const k of preset.envKeys) {
        const v = process.env[k];
        if (v) {
          cfg.api_key = v;
          break;
        }
      }
    }
  }

  // Browser MCP is opt-in PER SESSION via --browser, and never persisted:
  // a user must pass --browser each time they want it. We build a
  // session-only server list rather than mutating cfg.mcp_servers, because
  // cfg is written back to config.json by /model and /skills — persisting
  // browser there would silently re-enable it on every future launch.
  // Without the flag we also drop any 'browser' entry an older build left
  // in config, so it can never start automatically.
  // Strip any stale browser entry from the persisted config too, so a later
  // config.save() (from /model, /skills) removes it from config.json.
  cfg.mcp_servers = cfg.mcp_servers.filter((s) => !BROWSER_MCP_NAMES.has(s.name));
  const sessionServers = sessionMcpServers(cfg.mcp_servers, flags.browser);
  if (flags.browser) {
    logger.info('browser MCP enabled for this session', { source: '--browser' });
  }

  // LLM client.
  // Friendly pre-flight: catch the most common first-run failure (a hosted
  // backend with no API key) before the factory throws a bare error, and tell
  // the user exactly which env var to set or that /provider can configure it.
  const envForBackend: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    kimi: 'MOONSHOT_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    gemini: 'GEMINI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    naraya: 'NARAYA_API_KEY',
    dahl: 'DAHL_API_KEY',
  };
  const preset = getOpenAISchemeProvider(cfg.backend);
  const envVar = envForBackend[cfg.backend] ?? preset?.envKeys[0];
  if (envVar && !cfg.api_key) {
    process.stderr.write(
      `No API key for the '${cfg.backend}' backend.
  • set it for this shell:  export ${envVar}=<your-key>
  • or pass it once:        pentesterflow --api-key <your-key>
  • or configure it in the TUI with /provider
`,
    );
    return 1;
  }
  // If user picked "ollama" but base_url only speaks OpenAI /v1 (common on
  // RunPod proxies), auto-switch to openai-compat so /api/chat 404s don't
  // look like "model missing". Local ollama still wins when /api/tags works.
  if (
    (cfg.backend === 'ollama' || cfg.backend === '') &&
    cfg.base_url &&
    !/localhost|127\.0\.0\.1/i.test(cfg.base_url)
  ) {
    try {
      const { suggestBackendForOllamaUrl } = await import('../llm/wireDetect.js');
      const suggested = await suggestBackendForOllamaUrl(cfg.base_url);
      if (suggested === 'openai-compat') {
        cfg = { ...cfg, backend: 'openai-compat' };
        await config.save(cfg).catch(() => undefined);
        process.stderr.write(
          'ℹ base_url looks OpenAI-compatible only (/v1/models ok, /api/tags not) — switched backend to openai-compat.\n',
        );
      }
    } catch {
      // Probe is best-effort; factory will still run.
    }
  }

  let client: ReturnType<typeof llmFactory.newFromConfig>;
  try {
    client = llmFactory.newFromConfig(cfg);
  } catch (err) {
    process.stderr.write(
      `Failed to initialize the '${cfg.backend || 'ollama'}' backend: ${(err as Error).message}
Run with --help for setup flags, or use /provider in the TUI to reconfigure.
`,
    );
    return 1;
  }

  // Skills: walk built-in + project-local (.pentesterflow/skills) + user dirs.
  const skills = new SkillRegistry();
  const allSkillDirs = skillSearchDirs(cfg.skills_dirs);
  for (const d of allSkillDirs) skills.loadDir(d);
  // Apply persisted on/off state from config. Disabled skills stay in the
  // registry (so /skills can list them with [off]) but are hidden from
  // the system prompt and refused by load_skill.
  skills.setDisabledNames(cfg.disabled_skills);

  // Engagement target — shared with http tool + agent system prompt.
  const target = newTarget();
  // Engagement scope — shared with http/web_fetch tools + the scope tool.
  // Empty by default (opt-in enforcement, see target/scope.ts).
  const scope = new ScopeStore();

  // Bridges between agent prompters and the React tree. The publishers
  // are slotted in once the Ink App mounts; until then, prompts buffer
  // by holding the most recently set callback in these mutable holders.
  // A future polish pass will replace this with a React context provider.
  const permHolder: {
    publish: ((req: import('../ui/permBridge.js').PermissionRequest | null) => void) | null;
  } = { publish: null };
  const askHolder: {
    publish: ((req: import('../ui/askBridge.js').AskRequest | null) => void) | null;
  } = { publish: null };
  const bannerHolder: {
    publish: ((patch: Partial<BannerData>) => void) | null;
  } = { publish: null };
  // System-notice bridge — small "kind: system" appends from outside
  // the agent loop. Used by the live-reload watcher to surface
  // "skill reloaded" without spinning up a permission/ask modal.
  const noticeHolder: {
    publish: ((notice: NoticePayload) => void) | null;
  } = { publish: null };
  // Long shell commands (background: true) run detached; a completion
  // notice routes through the same out-of-band bridge as everything else
  // in noticeHolder, so it surfaces in the TUI the moment it finishes even
  // mid-conversation on something unrelated.
  const backgroundTasks = new BackgroundTaskManager((text) => noticeHolder.publish?.(text));
  const bridgedPerm = new BridgedPrompter((req) => permHolder.publish?.(req));
  const bridgedAsk = new BridgedAskPrompter((req) => askHolder.publish?.(req));
  const prompter = new YoloPrompter(bridgedPerm, flags.yolo);
  if (flags.yolo) {
    process.stderr.write(
      '⚠  YOLO mode active: every tool call will auto-approve. Authorized engagements / lab targets only.\n',
    );
  }

  // Findings store + notifier.
  const findingsStore = new FindingsStore('findings');
  const captureStore = new CaptureStore({ maxEntries: 5000 });

  // Session id is computed up here (was previously right before Agent
  // construction) because per-session stores like CoverageStore need it
  // to derive a stable file path before tools are registered.
  const sessionDir = sessionStore.dirFromPath('');
  sessionStore.cleanupStaleTemps(sessionDir, 60_000);
  let sessionID = flags.resumeID;
  let resuming = false;
  if (!sessionID) {
    sessionID = sessionStore.newID();
  } else {
    sessionStore.validateID(sessionID);
    resuming = true;
  }
  const sessionStoreInstance = sessionStore.Store.newWithID(sessionDir, sessionID);
  const sessionDebug = createSessionDebugLog({
    enabled: flags.debugSession,
    path: flags.debugSessionPath,
    sessionID,
  });
  if (sessionDebug.enabled) {
    sessionDebug.write('session_start', {
      version: VERSION,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      resume: resuming,
      backend: cfg.backend,
      model: cfg.model,
      base_url: cfg.base_url,
    });
    process.stderr.write(`debug session log: ${sessionDebug.path}\n`);
  }

  // Coverage tracking: which (endpoint, param, vuln_class) tuples the
  // agent has tried. Persists alongside findings so resumes keep state.
  const coverageStore = new CoverageStore(`findings/coverage-${sessionID}.json`);
  const intelligenceStore = new IntelligenceStore();
  // Curated, human-editable memory (Claude-Code-style facts). Its catalog is
  // pinned into the system prompt and matching facts recalled each turn, so a
  // `#`-saved fact stays in context for the rest of the session and beyond.
  const memoryStore = new MemoryStore();
  // Operator-authored engagement notes (scope/rules/creds). Read once at
  // startup from project + home .pentesterflow/engagement.md; always injected
  // into the system prompt so it survives compaction unconditionally.
  const engagement = new EngagementStore().load();
  // What the agent has learned about the operator (~/.pentesterflow/USER.md):
  // communication style, standing preferences, expectations. Always injected
  // into the system prompt, like engagement notes; the agent can append to it
  // autonomously via update_user_profile as well as through /user add.
  const userProfileStore = new UserProfileStore();
  // Optional external memory provider (opt-in via memory_provider config),
  // active alongside the built-in stores above — never instead of them.
  // null when disabled ('off'), or when 'sqlite' is selected but this Node
  // build lacks node:sqlite (needs 22.5+). The HTTP-backed providers
  // (mem0/honcho/hindsight/retaindb/supermemory/openviking) always
  // construct successfully — reachability of their backing service is a
  // per-call concern (recall/record degrade to a silent no-op), not a
  // startup one.
  const memoryProvider = await memoryProviderFactory.newFromConfig(cfg);
  if (cfg.memory_provider === 'sqlite' && !memoryProvider) {
    process.stderr.write(
      'warning: memory_provider "sqlite" requires Node 22.5+ (node:sqlite) — running with no external memory provider.\n',
    );
  }

  // Tools.
  const tools = new ToolRegistry();
  tools.register(new ShellTool('/bin/sh', 'shell', backgroundTasks));
  tools.register(new BashTool(backgroundTasks));
  tools.register(new BackgroundStatusTool(backgroundTasks));
  tools.register(new FileReadTool());
  tools.register(new FileReadToolAlias());
  tools.register(new FileWriteTool());
  tools.register(new FileWriteToolAlias());
  tools.register(new FileEditTool());
  tools.register(new FileEditToolAlias());
  tools.register(new GlobTool());
  tools.register(new GrepTool());
  tools.register(new HTTPTool(target, scope));
  tools.register(new WebFetchTool(scope));
  tools.register(new WebSearchTool());
  tools.register(new AskUserTool(bridgedAsk));
  tools.register(
    new ConfirmFindingTool(findingsStore, (finding, path) => {
      captureStore.addBurpIssue({
        id: `finding:${finding.slug}`,
        title: finding.title,
        severity: finding.severity,
        confidence: 'Certain',
        url: finding.url,
        method: finding.method,
        parameter: finding.parameter,
        detail: [
          finding.impact,
          finding.responseExcerpt ? `\nEvidence:\n${finding.responseExcerpt}` : '',
          finding.curl ? `\nReproduce:\n${finding.curl}` : '',
        ].join('\n'),
        remediation: finding.remediation,
        path,
        rawRequestB64: Buffer.from(findingRequestForBurp(finding), 'utf8').toString('base64'),
      });
      if (cfg.hooks.length > 0) {
        void runNotifyHooks(
          'finding-confirmed',
          {
            EVENT: 'finding-confirmed',
            FINDING_TITLE: finding.title,
            FINDING_SEVERITY: finding.severity,
            FINDING_PATH: path,
          },
          cfg.hooks,
          (text) => noticeHolder.publish?.(text),
        );
      }
    }),
  );
  tools.register(
    new LoadSkillTool(skills, async (skillName, objective, signal) => {
      const parent = agentRef.current;
      if (!parent) return 'error: skill fork called before the agent was ready';
      // Reuse delegate_task path: worker role + skill preload.
      const childTools = new ToolRegistry();
      for (const toolName of parent.tools.names()) {
        if (toolName === 'delegate_task') continue;
        const t = parent.tools.get(toolName);
        if (t) childTools.register(t);
      }
      const child = new Agent({
        client: parent.client,
        tools: childTools,
        skills: parent.skills,
        prompter: parent.prompter,
        store: null,
        target: parent.target,
        maxSteps: DELEGATE_MAX_STEPS,
        streamingEnabled: false,
      });
      const collected: AgentEvent[] = [];
      const progressTools: string[] = [];
      const progress = wireChildProgress(`skill:${skillName}`, (ev) => {
        if (ev.phase === 'tool' && ev.tool) progressTools.push(ev.tool);
        noticeHolder.publish?.(childProgressNoticeFromEvent(ev, progressTools));
      });
      await child.run(
        `Load the "${skillName}" skill first (load_skill without fork), then: ${objective}`,
        signal,
        (e) => {
          collected.push(e);
          progress(e);
        },
      );
      const result = summarizeDelegateEvents(collected, 'skill');
      const tally = Object.entries(result.toolTally)
        .map(([name, n]) => `${name}×${n}`)
        .join(', ');
      const header = `[skill-fork/${skillName}: ${result.stepCount} tool call(s)${tally ? ` — ${tally}` : ''}]`;
      const body = result.finalText || '(skill fork produced no final text)';
      const errNote = result.error ? `\n\nnote: ${result.error}` : '';
      return `${header}\n\n${body}${errNote}`;
    }),
  );
  tools.register(new ReadPayloadsTool(skills));
  tools.register(new ReadSkillFileTool(skills));
  tools.register(new CoverageTool(coverageStore));
  tools.register(new TodoTool());
  tools.register(new ScopeTool(scope));
  // The tool only needs to write through Agent.addUserProfileNote (which
  // also refreshes the live system prompt) — `agent` itself doesn't exist
  // yet at registration time, so the callback closes over this forward
  // reference (mutated via .current, not reassigned as a variable, right
  // after `new Agent(...)` below).
  const agentRef: { current?: Agent } = {};
  tools.register(
    new UpdateUserProfileTool(async (text) => {
      await agentRef.current?.addUserProfileNote(text);
    }),
  );
  // delegate_task: same forward-reference trick as above — the runner reads
  // agentRef.current lazily (only ever invoked well after `new Agent(...)`
  // below), and builds the child's tool registry from the parent's tools
  // minus delegate_task itself so a delegated agent can't delegate further.
  tools.register(
    new DelegateTool(async (objective, skill, role, signal, onProgress) => {
      const parent = agentRef.current;
      if (!parent) {
        return {
          finalText: 'error: delegate_task called before the agent was ready',
          toolTally: {},
          stepCount: 0,
          role,
        };
      }
      const childTools = new ToolRegistry();
      for (const toolName of parent.tools.names()) {
        if (toolName === 'delegate_task') continue;
        if (role === 'explore' && !isExploreAllowedTool(toolName)) continue;
        const t = parent.tools.get(toolName);
        if (t) childTools.register(t);
      }
      const child = new Agent({
        client: parent.client,
        tools: childTools,
        skills: parent.skills,
        prompter: parent.prompter,
        store: null,
        target: parent.target,
        maxSteps: DELEGATE_MAX_STEPS,
        streamingEnabled: false,
      });
      // Explore children stay in plan-style restriction as a second belt.
      if (role === 'explore') child.setPlanMode(true);
      const roleHint =
        role === 'explore'
          ? 'You are a READ-ONLY explore agent. Do not modify files or run shell commands. Search, read, fetch, and report findings only.\n\n'
          : '';
      const objectiveText = skill
        ? `${roleHint}Load the "${skill}" skill first (load_skill), then: ${objective}`
        : `${roleHint}${objective}`;
      const collected: AgentEvent[] = [];
      const progressTools: string[] = [];
      const progress = wireChildProgress(role, (ev) => {
        onProgress?.(ev);
        if (ev.phase === 'tool' && ev.tool) progressTools.push(ev.tool);
        noticeHolder.publish?.(childProgressNoticeFromEvent(ev, progressTools));
      });
      await child.run(objectiveText, signal, (e) => {
        collected.push(e);
        progress(e);
      });
      return summarizeDelegateEvents(collected, role);
    }),
  );
  if (memoryProvider) {
    for (const t of memoryProvider.tools()) tools.register(t);
  }
  for (const p of cfg.plugins) tools.register(new CommandPluginTool(p));

  // Burp/browser ingest server + capture-aware tools. The server only binds
  // when --burp is set; the tools are always registered so
  // the agent can call _status and learn the extension isn't running.
  registerBrowserCaptureTools((t) => tools.register(t), captureStore);
  let ingestHandle: IngestServerHandle | null = null;
  const ingestToken = randomBytes(16).toString('hex');
  const startBurpBridge = async (
    port = flags.burpPort,
  ): Promise<{ url: string; token: string; alreadyRunning: boolean }> => {
    if (ingestHandle)
      return { url: ingestHandle.url, token: ingestHandle.token, alreadyRunning: true };
    ingestHandle = await startIngestServer({
      store: captureStore,
      port,
      token: ingestToken,
      onEvent: (text) => noticeHolder.publish?.(text),
    });
    return { url: ingestHandle.url, token: ingestHandle.token, alreadyRunning: false };
  };
  const closeBurpBridge = async (): Promise<void> => {
    const handle = ingestHandle as IngestServerHandle | null;
    if (handle) await handle.close();
  };
  const generateFindingsReport = (format: 'markdown' | 'sarif') =>
    findingsStore.writeReport(format);
  if (flags.burp) {
    try {
      const result = await startBurpBridge(flags.burpPort);
      process.stderr.write(
        `PentesterFlow Burp bridge listening at ${result.url}\nPentesterFlow Burp bridge token: ${result.token}\nSet both values in the Burp plugin.\n`,
      );
    } catch (err) {
      process.stderr.write(
        `warning: --burp failed to start on :${flags.burpPort}: ${(err as Error).message}\n`,
      );
    }
  }

  // Every other risky primitive (shell, http, file write) is gated through
  // the Prompter before it runs; MCP servers previously spawned unconditionally
  // at startup with no consent step at all — a poisoned mcp_servers entry in
  // config.json (e.g. planted via a prompt-injected file_write the operator
  // waved through without reading the full diff) got unrestricted code
  // execution on the very next launch. This can't route through the Prompter
  // modal (the TUI hasn't mounted yet), so it's a one-time readline prompt per
  // server, gated on a persisted fingerprint of command/args/env — editing
  // config.json (by hand or by the agent) invalidates the stored approval and
  // re-prompts. The built-in browser MCP server is exempt: passing --browser
  // on the command line is itself the consent action.
  const approvedServers = await confirmMCPServers(
    sessionServers,
    cfg,
    flags.yolo,
    apiKeyPersistable,
  );

  // Spawn MCP children in parallel. Each child does its own handshake +
  // tool discovery, which can include network I/O (e.g. `npx -y ...`
  // fetching a package on first run) — running them serially multiplied
  // startup time linearly by the number of MCP servers.
  const mcpResults = await Promise.allSettled(approvedServers.map((s) => discoverMCPTools(s)));
  const mcpSessions: MCPSession[] = [];
  mcpResults.forEach((res, i) => {
    const s = approvedServers[i];
    if (!s) return;
    if (res.status === 'fulfilled') {
      mcpSessions.push(res.value.session);
      for (const t of res.value.tools) tools.register(t);
    } else {
      const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
      process.stderr.write(`mcp ${s.name}: ${err}\n`);
    }
  });

  // List-and-exit modes.
  if (flags.listSkills) {
    for (const sk of skills.list()) {
      process.stdout.write(`- ${sk.name}\n    ${sk.description}\n    (${sk.path})\n`);
    }
    await Promise.all(mcpSessions.map((s) => s.close()));
    await closeBurpBridge();
    await memoryProvider?.close();
    return 0;
  }
  if (flags.listTools) {
    for (const n of tools.names()) {
      const t = tools.get(n);
      const gated = t?.requiresPermission() ? ' [permission required]' : '';
      process.stdout.write(`- ${n}${gated}\n    ${t?.description() ?? ''}\n`);
    }
    await Promise.all(mcpSessions.map((s) => s.close()));
    await closeBurpBridge();
    await memoryProvider?.close();
    return 0;
  }

  // First-run setup. Asked exactly once, before the agent is built (so
  // the system prompt is constructed with the chosen profile). The
  // answer persists in ~/.pentesterflow/config.json so subsequent
  // launches skip this step.
  if (cfg.tooling_profile === undefined) {
    const picked = await runFirstRunPicker();
    if (picked === null) {
      await Promise.all(mcpSessions.map((s) => s.close()));
      await closeBurpBridge();
      await memoryProvider?.close();
      process.stderr.write('first-run setup cancelled — exiting.\n');
      return 0;
    }
    cfg.tooling_profile = picked;
    try {
      await persistConfig(cfg);
    } catch (err) {
      process.stderr.write(
        `warning: could not persist tooling_profile: ${(err as Error).message}\n`,
      );
    }
  }

  // Session + agent. (sessionID + sessionStoreInstance were created up
  // top so coverage / future per-session stores can reuse them.)
  const agent = new Agent({
    client,
    tools,
    skills,
    prompter,
    store: sessionStoreInstance,
    target,
    thinkingEnabled: cfg.thinking_enabled,
    maxSteps: cfg.max_steps > 0 ? cfg.max_steps : undefined,
    autoCompactThreshold: effectiveAutoCompactThreshold(cfg),
    toolingProfile: cfg.tooling_profile,
    promptProfile: effectivePromptProfile(cfg),
    intelligence: intelligenceStore,
    memoryStore,
    engagement,
    userProfileStore,
    memoryProvider,
    // --no-stream takes precedence over the config default so users can
    // toggle off streaming for a single launch without rewriting config.
    streamingEnabled: flags.noStream ? false : cfg.streaming_enabled,
    hooks: cfg.hooks,
  });
  agentRef.current = agent;

  let resumeSummary = '';
  if (resuming) {
    try {
      agent.resumeSaved();
      resumeSummary = buildResumeSummary(sessionID, agent.formatMemory());
    } catch (err) {
      process.stderr.write(`resume: ${(err as Error).message}\n`);
      return 1;
    }
  }

  // Live skill reload. fs.watch each loaded skill directory; on any
  // change, debounce 250 ms, clear the registry, re-walk every dir,
  // re-apply the disabled-skills set, and tell the agent to rebuild
  // its system prompt so the change takes effect on the next turn.
  // We surface a one-line system notice in the transcript so the user
  // can confirm the reload landed.
  const skillDirsToWatch = allSkillDirs.filter((d) => existsSync(d));
  const watchers: FSWatcher[] = [];
  let reloadTimer: NodeJS.Timeout | null = null;
  const triggerReload = (): void => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      try {
        skills.clear();
        for (const d of skillDirsToWatch) skills.loadDir(d);
        // Persisted disabled state stays — only what's on disk changes.
        skills.setDisabledNames(cfg.disabled_skills);
        agent.rebuildFromSkills();
        const count = skills.listEnabled().length;
        noticeHolder.publish?.(`skills: reloaded (${count} enabled)`);
        logger.info('skills reloaded', { enabled: count, total: skills.list().length });
      } catch (err) {
        logger.warn('skills reload failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }, 250);
  };
  const watchedDirs = new Set<string>();
  const watchDir = (d: string): void => {
    if (watchedDirs.has(d) || !existsSync(d)) return;
    watchedDirs.add(d);
    try {
      // Recursive watching keeps payloads/ + nested dirs covered too.
      // Not supported on every libuv platform; fall back to a shallow
      // watch and rely on debounced full-reload for inner-file events.
      watchers.push(fsWatch(d, { recursive: true }, triggerReload));
    } catch {
      try {
        watchers.push(fsWatch(d, triggerReload));
      } catch {
        // best-effort — a watcher failure shouldn't block startup.
      }
    }
  };
  for (const d of skillDirsToWatch) watchDir(d);

  // When the user scaffolds a skill via `/skills new`, its dir (e.g.
  // ./.pentesterflow/skills) may not have existed at startup, so it wasn't being
  // watched. Add it to the reload walk + a watcher so subsequent edits
  // hot-reload like any other skill.
  const onSkillCreated = (skillRootDir: string): void => {
    if (!skillDirsToWatch.includes(skillRootDir)) skillDirsToWatch.push(skillRootDir);
    watchDir(skillRootDir);
    triggerReload();
  };

  // Banner data.
  const bannerData: BannerData = {
    provider: providerLabel(cfg.backend),
    model: client.model() || cfg.model || '(none — set with /model)',
    endpoint: cfg.base_url || defaultEndpoint(cfg.backend),
    state: localityFor(cfg.backend),
    status: `Session ${sessionID.slice(0, 8)} — type /help to begin`,
    cwd: prettyCwd(),
    toolSupport: 'probing',
  };

  // Probe the active model in the background. Two probes:
  //   1. Tool-calling: does this model emit `tool_calls`? If not, the
  //      agent loop spins until max_steps every turn — we'd rather show
  //      a banner pill so the user notices before sending a prompt.
  //   2. Ollama num_ctx: if smaller than auto_compact_threshold, the
  //      backend silently truncates input. Warn so the user can bump it.
  //
  // Both probes are best-effort; errors collapse to 'unknown' state and
  // never block startup. Re-run after every applyProvider() so a /model
  // swap re-probes the new model.
  // Both call sites below invoke this fire-and-forget (`void runProbes(...)`,
  // no .catch()) — a synchronous throw in the pre-await portion (e.g. a
  // malformed base_url reaching detectOllamaContextWindow's URL construction)
  // becomes a rejected promise with nothing attached to it, which is an
  // unhandled rejection that can crash the whole TUI under Node's default
  // behavior. The try/catch below ensures this async function can never
  // reject, regardless of what runs before its first await.
  const runProbes = async (signal: AbortSignal): Promise<void> => {
    try {
      await runProbesInner(signal);
    } catch (err) {
      logger.error('agent: probe failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const runProbesInner = async (signal: AbortSignal): Promise<void> => {
    bannerHolder.publish?.({ toolSupport: 'probing', contextWindow: undefined });
    const modelWarning = modelReliabilityWarning(cfg.backend, agent.client.model());
    if (modelWarning) {
      process.stderr.write(`${modelWarning}\n`);
      noticeHolder.publish?.(modelWarning);
    }
    const probeP = probeToolSupport(agent.client, signal).then((r) => {
      bannerHolder.publish?.({ toolSupport: r.toolSupport });
      if (r.toolSupport === 'no' && r.detail) {
        process.stderr.write(`⚠  model ${agent.client.model()}: ${r.detail}\n`);
      }
    });
    const ctxP =
      cfg.backend === 'ollama' || cfg.backend === ''
        ? detectOllamaContextWindow(
            cfg.base_url || defaultEndpoint(cfg.backend),
            agent.client.model(),
            signal,
          ).then((info) => {
            if (!info) return;
            bannerHolder.publish?.({ contextWindow: info.numCtx });
            // Apply the detected window so the chat requests actually send
            // options.num_ctx — otherwise Ollama silently truncates input at
            // its 2048 default no matter what the model metadata reports.
            if (agent.client instanceof OllamaClient) agent.client.setNumCtx(info.numCtx);
            const threshold = agent.getAutoCompactThreshold();
            // Size the auto-compact threshold to fit the detected window so
            // the agent compacts BEFORE Ollama silently truncates input from
            // the front. That front-truncation drops the system prompt (the
            // findings/tool-result discipline) and the earliest facts — the
            // root cause of local-model hallucination: invented tool output,
            // false findings, ignored errors, and lost context. 0.7 leaves
            // headroom for the tool definitions and the response, which also
            // share num_ctx.
            //
            // Lowering always applies — that's the truncation-safety case
            // above and must win regardless of user config. Raising only
            // applies when the user hasn't set an explicit threshold (still
            // at the schema default): otherwise a large-window local model
            // (200k+ ctx) stays stuck compacting at the 16k default forever,
            // but an explicit user value is a deliberate choice and must be
            // respected, not silently overridden upward.
            if (threshold > 0) {
              const safe = Math.floor(info.numCtx * 0.7);
              const userConfigured =
                cfg.auto_compact_threshold !== config.DEFAULT_AUTO_COMPACT_THRESHOLD;
              if (safe < threshold) {
                agent.setAutoCompactThreshold(safe);
                const msg = `ℹ auto-compact threshold lowered to ${safe} tokens to fit ollama num_ctx ${info.numCtx} (source: ${info.source}); prevents silent context truncation.`;
                process.stderr.write(`${msg}\n`);
                noticeHolder.publish?.(msg);
              } else if (safe > threshold && !userConfigured) {
                agent.setAutoCompactThreshold(safe);
                const msg = `ℹ auto-compact threshold raised to ${safe} tokens to use ollama num_ctx ${info.numCtx} (source: ${info.source}); default 16k was compacting this window early.`;
                process.stderr.write(`${msg}\n`);
                noticeHolder.publish?.(msg);
              }
              // Even after clamping, a tiny window can't hold a useful agent
              // prompt (system + tools alone may exceed it), so context loss —
              // and hallucination — is unavoidable until it's raised.
              if (info.numCtx < 4096) {
                process.stderr.write(
                  `⚠  ollama num_ctx is only ${info.numCtx} (source: ${info.source}). The system prompt + tools may not fit, so the model will lose context and hallucinate. Bump it: ollama show <m> --modelfile > m && echo "PARAMETER num_ctx 32768" >> m && ollama create <m>-32k -f m\n`,
                );
              }
            }
          })
        : Promise.resolve();
    await Promise.allSettled([probeP, ctxP]);
  };
  void runProbes(rootCtl.signal);
  if (cfg.hooks.length > 0) {
    void runNotifyHooks(
      'session-start',
      { EVENT: 'session-start', SESSION_ID: sessionID, TARGET: target.baseURL() },
      cfg.hooks,
      (text) => noticeHolder.publish?.(text),
    );
  }

  // Shared props for both the Ink and OpenTUI trees; wire bridge publishers
  // into dispatch via bindPermPublisher / bindAskPublisher. The agent
  // goroutine pushes PermissionRequest / AskRequest through the bridges;
  // the App reducer surfaces them as modals. readConfig / applyProvider
  // feed the interactive /provider + /model pickers.
  const appProps = {
    agent,
    bannerData,
    parentSignal: rootCtl.signal,
    yoloInitial: flags.yolo,
    bindPermPublisher: (publish) => {
      permHolder.publish = publish;
    },
    bindAskPublisher: (publish) => {
      askHolder.publish = publish;
    },
    bindBannerPublisher: (publish) => {
      bannerHolder.publish = publish;
    },
    bindNoticePublisher: (publish) => {
      noticeHolder.publish = publish;
    },
    resumeSummary,
    sessionDebug,
    setYolo: (on: boolean) => prompter.setYolo(on),
    setPermissionMode: (mode: 'ask' | 'auto-safe' | 'yolo') => prompter.setMode(mode),
    listJobs: () => formatJobsList(backgroundTasks.list()),
    onSkillCreated,
    readConfig: () => ({
      backend: cfg.backend,
      baseURL: cfg.base_url,
      apiKey: cfg.api_key,
      model: cfg.model,
      customModels: [...(cfg.custom_models ?? [])],
    }),
    persistDisabledSkills: async (names: string[]) => {
      cfg.disabled_skills = [...names].sort();
      await persistConfig(cfg);
    },
    applyProvider: async (change) => {
      cfg.backend = change.backend;
      cfg.model = change.model;
      if (change.baseURL !== undefined) cfg.base_url = change.baseURL;
      // An explicit key entered through /provider is the user's own
      // durable configuration step — unlike --api-key, it's meant to
      // persist, so it lifts the ephemeral-key guard from here on.
      if (change.apiKey !== undefined) {
        cfg.api_key = change.apiKey;
        apiKeyPersistable = true;
      }
      // Remote "ollama" URL that only speaks /v1 → openai-compat.
      if (
        (cfg.backend === 'ollama' || cfg.backend === '') &&
        cfg.base_url &&
        !/localhost|127\.0\.0\.1/i.test(cfg.base_url)
      ) {
        try {
          const { suggestBackendForOllamaUrl } = await import('../llm/wireDetect.js');
          const suggested = await suggestBackendForOllamaUrl(cfg.base_url);
          if (suggested === 'openai-compat') {
            cfg.backend = 'openai-compat';
            noticeHolder.publish?.(
              'base_url is OpenAI-compatible only — using openai-compat instead of ollama',
            );
          }
        } catch {
          /* probe best-effort */
        }
      }
      // Remember model ids the user selected (including custom / fine-tune
      // names) so /model list can surface them without a live catalog hit.
      if (change.model) {
        cfg.custom_models = [
          change.model,
          ...(cfg.custom_models ?? []).filter((m) => m !== change.model),
        ].slice(0, 40);
      }
      const next = llmFactory.newFromConfig(cfg);
      agent.setClient(next);
      agent.setAutoCompactThreshold(effectiveAutoCompactThreshold(cfg));
      agent.setPromptProfile(effectivePromptProfile(cfg));
      await persistConfig(cfg);
      // New client → re-probe so the banner pill reflects the new
      // model's capabilities, not the old one's.
      bannerHolder.publish?.({
        provider: providerLabel(cfg.backend),
        model: next.model() || cfg.model || '(none — set with /model)',
        endpoint: cfg.base_url || defaultEndpoint(cfg.backend),
        state: localityFor(cfg.backend),
      });
      void runProbes(rootCtl.signal);
    },
    startBurpBridge,
    generateFindingsReport,
  } satisfies AppProps;

  try {
    await runOpenTuiApp(appProps);
  } finally {
    sessionDebug.write('session_exit');
    process.stderr.write(`${buildExitResumeHint(sessionID)}\n`);
    // Trip the root abort signal before tearing down MCP sessions and the
    // ingest server. The TUI's own Ctrl-C path aborts the per-run signal
    // (runCtl) and then calls exit(), but never the root signal — so any
    // background tool that holds rootCtl.signal (e.g. plugins, long-lived
    // MCP requests) would otherwise keep running while we close.
    rootCtl.abort();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* best-effort */
      }
    }
    if (reloadTimer) clearTimeout(reloadTimer);
    await Promise.all(mcpSessions.map((s) => s.close()));
    await closeBurpBridge();
    await memoryProvider?.close();
  }
  return 0;
}

// ---------- helpers ----------

function providerLabel(b: string): string {
  const preset = getOpenAISchemeProvider(b);
  if (preset) return preset.name;
  switch (b) {
    case 'ollama':
    case '':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'openai':
      return 'OpenAI';
    case 'openai-compat':
      return 'OpenAI-compatible';
    case 'kimi':
      return 'Kimi';
    case 'groq':
      return 'Groq';
    case 'openrouter':
      return 'OpenRouter';
    case 'deepseek':
      return 'DeepSeek';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
      return 'Claude';
    case 'naraya':
      return 'Naraya';
    case 'dahl':
      return 'Dahl';
    default:
      return b;
  }
}

function localityFor(b: string): string {
  if (isOpenAISchemeProvider(b)) return 'remote';
  return b === 'openai' ||
    b === 'openai-compat' ||
    b === 'kimi' ||
    b === 'groq' ||
    b === 'openrouter' ||
    b === 'deepseek' ||
    b === 'gemini' ||
    b === 'anthropic' ||
    b === 'naraya' ||
    b === 'dahl'
    ? 'remote'
    : 'local';
}

function defaultEndpoint(b: string): string {
  const preset = getOpenAISchemeProvider(b);
  if (preset) return preset.baseURL;
  switch (b) {
    case 'ollama':
    case '':
      return 'http://localhost:11434';
    case 'lmstudio':
      return 'http://localhost:1234/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'kimi':
      return KIMI_DEFAULT_BASE_URL;
    case 'groq':
      return GROQ_DEFAULT_BASE_URL;
    case 'openrouter':
      return OPENROUTER_DEFAULT_BASE_URL;
    case 'deepseek':
      return DEEPSEEK_DEFAULT_BASE_URL;
    case 'gemini':
      return GEMINI_DEFAULT_BASE_URL;
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'naraya':
      return NARAYA_DEFAULT_BASE_URL;
    case 'dahl':
      return DAHL_DEFAULT_BASE_URL;
    default:
      return '';
  }
}

function effectiveAutoCompactThreshold(cfg: config.Config): number {
  if (cfg.backend === 'groq') {
    if (cfg.auto_compact_threshold <= 0) return GROQ_AUTO_COMPACT_THRESHOLD;
    return Math.min(cfg.auto_compact_threshold, GROQ_AUTO_COMPACT_THRESHOLD);
  }
  // Kimi's k2.6/k2.5 carry a 256K window; the generic 16K default would
  // compact away ~94% of it. When the user hasn't customized the threshold,
  // size it to the model's real context window. An explicit setting (any
  // value other than the schema default) is always respected.
  if (
    cfg.backend === 'kimi' &&
    cfg.auto_compact_threshold === config.DEFAULT_AUTO_COMPACT_THRESHOLD
  ) {
    return kimiAutoCompactThreshold(cfg.model) ?? cfg.auto_compact_threshold;
  }
  return cfg.auto_compact_threshold;
}

function effectivePromptProfile(cfg: config.Config): PromptProfile {
  return cfg.backend === 'groq' || cfg.backend === 'gemini' ? 'compact' : 'full';
}

function buildResumeSummary(sessionID: string, memory: string): string {
  return [`Resumed session ${sessionID}`, '', 'Previous session recap:', '', memory].join('\n');
}

function buildExitResumeHint(sessionID: string): string {
  return `Resume this session: pentesterflow --resume ${sessionID}`;
}

function prettyCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/**
 * Gate MCP server spawn behind a one-time consent prompt, printed to the raw
 * terminal before the Ink app mounts (the Prompter modal that gates shell/
 * http/file-write isn't usable yet at this point in startup). A server is
 * spawned without prompting when: --yolo is set, it's the built-in browser
 * server (--browser on the command line is itself the consent), or its
 * command/args/env fingerprint matches one already approved in
 * cfg.mcp_approved. Declined/errored servers are dropped from the returned
 * list rather than spawned. Approvals are persisted to config so this only
 * prompts again when the entry actually changes.
 */
async function confirmMCPServers(
  servers: config.MCPServerConfig[],
  cfg: config.Config,
  yolo: boolean,
  apiKeyPersistable: boolean,
): Promise<config.MCPServerConfig[]> {
  const pending = servers.filter(
    (s) =>
      !BROWSER_MCP_NAMES.has(s.name) &&
      !yolo &&
      cfg.mcp_approved[s.name] !== mcpServerFingerprint(s),
  );
  if (pending.length === 0) return servers;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const approved = new Set<string>();
  try {
    for (const s of pending) {
      process.stderr.write(
        `\nMCP server "${s.name}" wants to run on every launch:\n  ${s.command} ${s.args.join(' ')}\n`,
      );
      const answer = await rl.question('  Allow? [y/N] ');
      if (answer.trim().toLowerCase().startsWith('y')) {
        approved.add(s.name);
        cfg.mcp_approved[s.name] = mcpServerFingerprint(s);
      } else {
        process.stderr.write(`  Skipped "${s.name}" — not spawned this session.\n`);
      }
    }
  } finally {
    rl.close();
  }
  if (approved.size > 0) {
    // Same ephemeral-key guard as persistConfig() in main() — this function
    // saves cfg for an unrelated reason (mcp_approved) and must not carry a
    // --api-key-sourced key to disk as a side effect.
    await config.save(apiKeyPersistable ? cfg : { ...cfg, api_key: '' }).catch(() => undefined);
  }

  return servers.filter((s) => !pending.includes(s) || approved.has(s.name));
}

/**
 * Show the first-run picker as a short-lived OpenTUI scene.
 * Returns null if the user Esc'd or Ctrl-C'd.
 */
async function runFirstRunPicker(): Promise<config.ToolingProfile | null> {
  return runFirstRunPickerOpenTui();
}

/** Mount the OpenTUI app (alternate screen) until onExit / destroy. */
async function runOpenTuiApp(appProps: AppProps): Promise<void> {
  const { createCliRenderer } = await import('@opentui/core');
  const { createRoot } = await import('@opentui/react');
  const { App: OpenTuiApp } = await import('../ui-opentui/App.js');
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // we handle Ctrl-C explicitly to abort the agent first
    // Mouse-drag text selection → OSC 52 clipboard copy (see App.tsx's
    // useSelectionHandler). Enabling this hands mouse events to the
    // renderer rather than leaving them to the terminal's own native
    // selection, which is why the app copies selections itself instead of
    // relying on native mouse-select-copy.
    useMouse: true,
  });
  await new Promise<void>((resolveExit) => {
    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      renderer.destroy();
      resolveExit();
    };
    createRoot(renderer).render(React.createElement(OpenTuiApp, { ...appProps, onExit }));
  });
}

/** First-run profile picker — short-lived renderer, destroyed on pick or cancel. */
async function runFirstRunPickerOpenTui(): Promise<config.ToolingProfile | null> {
  const { createCliRenderer } = await import('@opentui/core');
  const { createRoot } = await import('@opentui/react');
  const { FirstRunPicker: OpenTuiFirstRunPicker } = await import('../ui-opentui/FirstRunPicker.js');
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  return new Promise((resolveOuter) => {
    let done = false;
    const finish = (picked: config.ToolingProfile | null) => {
      if (done) return;
      done = true;
      renderer.destroy();
      resolveOuter(picked);
    };
    createRoot(renderer).render(
      React.createElement(OpenTuiFirstRunPicker, {
        onPick: (p: config.ToolingProfile) => finish(p),
        onCancel: () => finish(null),
      }),
    );
  });
}

function printHelp(): void {
  process.stdout.write(`pentesterflow ${VERSION}

Usage:
  pentesterflow [flags]

Flags:
  --backend ollama|lmstudio|openai|openai-compat|kimi|groq|openrouter|deepseek|gemini|anthropic|naraya|dahl
  --model <id>
  --base-url <url>
  --api-key <key>            visible to other local users via ps/procfs; prefer env var or /provider
  --skills <dirs>            comma-separated extra skill directories
  --resume <session-id>
  --browser                  enable Browser MCP for this session only (not persisted)
  --burp [port]              start local Burp/PentesterFlow bridge (default :9999)
  --browser-ingest [port]    deprecated alias for --burp
  --no-stream                disable streaming chat (fallback for backends
                             whose SSE/ND-JSON path drops tool_calls)
  --yolo                     YOLO mode: auto-approve non-sensitive tool calls
                             (alias: --dangerously-skip-permissions)
  --list-skills / --list-tools
  --log <path>
  --debug-session           write a complete JSONL session debug log
  --debug-session-path <p>  custom path for --debug-session
  --version / --help

API keys (hosted backends) — set via flag, /provider in the TUI, or env var:
  openai      OPENAI_API_KEY
  kimi        MOONSHOT_API_KEY (or KIMI_API_KEY)
  groq        GROQ_API_KEY
  openrouter  OPENROUTER_API_KEY
  deepseek    DEEPSEEK_API_KEY
  gemini      GEMINI_API_KEY
  anthropic   ANTHROPIC_API_KEY
  naraya      NARAYA_API_KEY
  dahl        DAHL_API_KEY
  (ollama / lmstudio run locally and need no key)

Backends: ollama · lmstudio · openai · openai-compat · kimi · groq ·
  openrouter · deepseek · gemini · anthropic · naraya · dahl
  + OpenCode presets: xai · mistral · cerebras · togetherai · runcrate · deepinfra ·
  fireworks · baseten · nvidia · perplexity · cohere · alibaba · venice ·
  zenmux · kilo · llmgateway · opencode
Custom gateways: /provider → "Custom OpenAI scheme" or "Custom Anthropic scheme"
  (any base URL + key + model id). /model <id> accepts any custom model id.

In the TUI: Enter send · Esc cancel turn · Ctrl-C quit
  Scroll: PgUp/PgDn/Home/End · mouse wheel
Slash: /help /plan /clear /reset /exit /target /maxsteps /thinking /update
`);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
