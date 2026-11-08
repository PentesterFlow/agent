// Config file at ~/.pentesterflow/config.json (override with PENTESTERFLOW_CONFIG).
//
// Design goals for the on-disk format:
//   • Human-readable — stable key order, 2-space indent, trailing newline.
//   • Minimal — empty strings/arrays and schema defaults are omitted on save
//     so the file only shows what the user (or /provider) actually set.
//   • Editable — JSONC is accepted on load (// and /* */ comments) so people
//     can annotate their config; comments are not rewritten (JSON can't keep
//     them) but the next save stays compact and ordered.
//   • Safe — atomic write (tmp + fsync + rename) with mode 0o600.
//
// Loaded once at startup; later /provider and /model mutations call save().

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ---------- Schema ----------

// Core backends + OpenCode-aligned OpenAI-scheme presets (see providerRegistry).
// Keep in sync with openaiSchemeBackendIds() when adding presets.
const Backend = z.enum([
  '',
  'ollama',
  'lmstudio',
  'openai',
  'openai-compat',
  'kimi',
  'groq',
  'openrouter',
  'deepseek',
  'gemini',
  'anthropic',
  'naraya',
  'dahl',
  // OpenCode plugin/provider list (OpenAI Chat Completions scheme)
  'xai',
  'mistral',
  'cerebras',
  'togetherai',
  'runcrate',
  'deepinfra',
  'fireworks',
  'baseten',
  'nvidia',
  'perplexity',
  'cohere',
  'alibaba',
  'venice',
  'zenmux',
  'kilo',
  'llmgateway',
  'opencode',
]);
export type Backend = z.infer<typeof Backend>;

/** Every non-empty backend id. Used for CLI flag validation and help text. */
export const BACKENDS: readonly Exclude<Backend, ''>[] = [
  'ollama',
  'lmstudio',
  'openai',
  'openai-compat',
  'kimi',
  'groq',
  'openrouter',
  'deepseek',
  'gemini',
  'anthropic',
  'naraya',
  'dahl',
  'xai',
  'mistral',
  'cerebras',
  'togetherai',
  'runcrate',
  'deepinfra',
  'fireworks',
  'baseten',
  'nvidia',
  'perplexity',
  'cohere',
  'alibaba',
  'venice',
  'zenmux',
  'kilo',
  'llmgateway',
  'opencode',
];

const MCPServerConfig = z.object({
  name: z.string().min(1),
  command: z.string().min(1).refine(noShellMeta, {
    message: 'mcp_servers[].command must not contain shell metacharacters',
  }),
  // Validated per-element, not just on `command`: since the SDK spawns via
  // an argv array (no shell), metachars here can't be shell-interpreted —
  // but a payload like `-c "curl x|bash"` is still a real injection vector
  // when command is an interpreter (bash/sh/python/node -e), so reject the
  // same character set element-wise as defense in depth.
  args: z
    .array(
      z.string().refine(noShellMeta, {
        message: 'mcp_servers[].args must not contain shell metacharacters',
      }),
    )
    .default([]),
  env: z.record(z.string()).optional(),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfig>;

const PluginConfig = z.object({
  name: z.string().min(1),
  command: z.string().min(1).refine(noShellMeta, {
    message: 'plugins[].command must not contain shell metacharacters',
  }),
  args: z.array(z.string()).default([]),
  description: z.string().default(''),
  schema: z.record(z.unknown()).optional(),
  requires_permission: z.boolean().default(false),
});
export type PluginConfig = z.infer<typeof PluginConfig>;

const ToolingProfile = z.enum(['minimal', 'full']);
export type ToolingProfile = z.infer<typeof ToolingProfile>;

const HookEvent = z.enum(['pre-tool-call', 'post-tool-call', 'session-start', 'finding-confirmed']);
export type HookEvent = z.infer<typeof HookEvent>;

const HookConfig = z.object({
  event: HookEvent,
  // Optional tool-name substring match (e.g. "shell" matches BashTool/ShellTool
  // via their canonical name). Absent = fires for every event of this type.
  // Only meaningful for pre-tool-call/post-tool-call.
  matcher: z.string().optional(),
  command: z.string().min(1).refine(noShellMeta, {
    message: 'hooks[].command must not contain shell metacharacters',
  }),
  // Validated per-element for the same reason as MCPServerConfig.args: since
  // command spawns via argv array (no shell), metachars here can't be
  // shell-interpreted — but when command is an interpreter (bash/sh/python/
  // node -e), a payload like `-c "curl x|bash"` is still a real injection
  // vector, and hooks run automatically on every tool call, a larger
  // surface than an MCP server spawned once at startup by explicit opt-in.
  args: z
    .array(
      z.string().refine(noShellMeta, {
        message: 'hooks[].args must not contain shell metacharacters',
      }),
    )
    .default([]),
});
export type HookConfig = z.infer<typeof HookConfig>;

/** Schema default for auto_compact_threshold. Exported so backend-specific
 *  overrides (e.g. large-context Kimi models) can detect "user is on the
 *  default" and size the threshold to the model's real context window. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 16000;

const ConfigSchema = z.object({
  backend: Backend.default(''),
  model: z.string().default(''),
  base_url: z.string().default(''),
  api_key: z.string().default(''),
  // User-entered model ids (fine-tunes, dated snapshots, proxy renames, custom
  // gateway names) remembered across sessions so /model list and the picker
  // surface them without requiring a live catalog hit.
  custom_models: z.array(z.string().min(1)).default([]),
  skills_dirs: z.array(z.string()).default([]),
  // Skill names the user has disabled via /skills. Hidden from the system
  // prompt and refused by load_skill until re-enabled. Persisted so the
  // selection survives restarts.
  disabled_skills: z.array(z.string()).default([]),
  mcp_servers: z.array(MCPServerConfig).default([]),
  // (server name -> mcpServerFingerprint) for user-configured MCP servers the
  // user has explicitly consented to spawn. Unlike shell/http/file-write,
  // which are gated per-call through the Prompter, MCP servers spawn once at
  // startup, before the TUI mounts — so consent is captured here via a
  // one-time readline prompt (see cli/index.ts) and persisted rather than
  // asked through the Prompter modal. A changed fingerprint (edited
  // command/args/env) invalidates the stored approval and re-prompts.
  mcp_approved: z.record(z.string()).default({}),
  plugins: z.array(PluginConfig).default([]),
  // Automation hooks: run `command` on pre-tool-call/post-tool-call/
  // session-start/finding-confirmed. A pre-tool-call hook that exits
  // non-zero blocks the tool call (its stderr becomes the tool's error
  // result); every other event type is fire-and-forget. Empty by default.
  hooks: z.array(HookConfig).default([]),
  session_path: z.string().default(''),
  thinking_enabled: z.boolean().default(false),
  // Stream chat deltas as they arrive. Disable when a model's streaming
  // path drops tool_calls (some quantized Ollama builds) or when an
  // OpenAI-compat server doesn't support SSE.
  streaming_enabled: z.boolean().default(true),
  max_steps: z.number().int().nonnegative().default(0),
  // Auto-compaction: when the agent's approxTokens() exceeds this
  // threshold, the next Run starts by compacting the session. 0
  // disables (manual /compact only). The default of 16000 tokens leaves
  // headroom for smaller local models (4k-8k context) and is harmless
  // for larger ones; users can raise it if they want longer threads.
  auto_compact_threshold: z.number().int().nonnegative().default(DEFAULT_AUTO_COMPACT_THRESHOLD),
  // Sampling temperature. Unset → use the provider default. Sent only to
  // models that accept it: kimi-k2.6 / k2.5 lock it to 1 and reject anything
  // else, so a configured value is silently skipped for those.
  temperature: z.number().min(0).max(2).optional(),
  // Per-response token cap. Unset → provider default (Kimi falls back to
  // KIMI_DEFAULT_MAX_TOKENS so it can't narrate unbounded). Bounds latency
  // and runaway generations; raise it if long final answers get truncated.
  max_tokens: z.number().int().positive().optional(),
  // Gemini-only: cap the model's internal "thinking" budget (in tokens). Gemini
  // 2.5/3 Flash models think on every turn by default, which dominates latency
  // across an agent loop. 0 disables thinking entirely (fastest); a positive
  // value caps it. Unset → leave the API default (no thinkingConfig sent, so
  // models without the knob aren't affected).
  gemini_thinking_budget: z.number().int().nonnegative().optional(),
  // Tooling profile: which tools the agent reaches for by default.
  //   'minimal' — curl + Unix only (jq, grep, awk, sed, head, sort, uniq).
  //   'full'    — adds ffuf, nuclei, sqlmap, gobuster, subfinder, httpx,
  //               wfuzz, masscan when locally available.
  // Undefined means the user hasn't been asked yet — the CLI triggers a
  // one-time first-run picker in that case and writes the answer back.
  tooling_profile: ToolingProfile.optional(),
  // Optional external memory provider, active alongside (never instead of)
  // the built-in MEMORY.md/USER.md/curated-facts stack. 'off' by default —
  // opt-in. 'sqlite' is local-only (node:sqlite FTS5; degrades to 'off' on
  // Node <22.5). The rest are HTTP-backed services the user runs or
  // subscribes to themselves — api_key/base_url below, or the provider's own
  // env var (MEM0_API_KEY, HONCHO_API_KEY, ...), configure them.
  memory_provider: z
    .enum(['off', 'sqlite', 'mem0', 'honcho', 'hindsight', 'retaindb', 'supermemory', 'openviking'])
    .default('off'),
  // Generic bucket for whichever fields the selected memory_provider needs.
  // Kept flat rather than one-schema-per-provider since each provider only
  // reads the 2-4 fields relevant to it; unused fields are simply ignored.
  memory_provider_config: z
    .object({
      base_url: z.string().default(''),
      api_key: z.string().default(''),
      // honcho: workspace + this agent's peer name.
      workspace: z.string().default(''),
      peer_name: z.string().default(''),
      // hindsight: which memory bank to read/write.
      bank_id: z.string().default(''),
      // supermemory: the container tag namespacing this agent's memories.
      container_tag: z.string().default(''),
      // retaindb / mem0: scoping identifiers for multi-user deployments.
      project: z.string().default(''),
      user_id: z.string().default(''),
    })
    .default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

function noShellMeta(s: string): boolean {
  // Rejection set: any of these in a command path
  // is almost always an injection attempt rather than a real binary name.
  return !/[|&;<>$`\\\n]/.test(s) && !s.includes('$(') && !s.includes('${');
}

// ---------- Paths ----------

export function configPath(): string {
  const override = process.env.PENTESTERFLOW_CONFIG;
  if (override && override.length > 0) return override;
  const home = homedir();
  return join(home, '.pentesterflow', 'config.json');
}

// ---------- Load / save ----------

/**
 * Key order written to disk. Groups related settings so a hand-edited
 * config.json reads top-to-bottom like a short manual:
 *   provider → models → skills → integrations → agent knobs → memory
 */
export const CONFIG_KEY_ORDER: readonly (keyof Config)[] = [
  'backend',
  'model',
  'base_url',
  'api_key',
  'custom_models',
  'skills_dirs',
  'disabled_skills',
  'tooling_profile',
  'mcp_servers',
  'mcp_approved',
  'plugins',
  'hooks',
  'session_path',
  'thinking_enabled',
  'streaming_enabled',
  'max_steps',
  'auto_compact_threshold',
  'temperature',
  'max_tokens',
  'gemini_thinking_budget',
  'memory_provider',
  'memory_provider_config',
] as const;

export function load(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    return ConfigSchema.parse({});
  }
  let raw: unknown;
  try {
    const buf = readFileSync(path, 'utf8');
    raw = parseConfigText(buf);
  } catch (err) {
    throw new Error(`config: failed to read ${path}: ${stringifyError(err)}`);
  }
  // Drop documentation-only keys a human may have added ($schema, $comment, …)
  // before schema validation so they never break load.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = stripDocKeys(raw as Record<string, unknown>);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`config: ${path}: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/**
 * Atomically save the config: write to a sibling .tmp file with O_EXCL +
 * 0o600 from the moment of creation (no readable window), fsync, then
 * rename. Cleans up the .tmp on any error path.
 *
 * The body is a compact, ordered JSON document (see {@link formatConfig}).
 */
export async function save(cfg: Config): Promise<void> {
  const path = configPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const body = formatConfig(cfg);
  const tmp = join(dir, `.pentesterflow.cfg.tmp.${randomBytes(3).toString('hex')}`);

  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmp, 'wx', 0o600);
    await fh.writeFile(body);
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, path);
    // Tighten perms on any pre-existing file that may have been world-
    // readable from an older build. The rename above can preserve the
    // destination inode's permissions on some filesystems.
    await chmod(path, 0o600).catch(() => undefined);
  } catch (err) {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw new Error(`config: save failed: ${stringifyError(err)}`);
  }
}

/**
 * Serialize a Config for humans: omit empty/default values, stable key order,
 * 2-space indent, trailing newline. Round-trips through {@link load} because
 * omitted keys re-expand to schema defaults.
 */
export function formatConfig(cfg: Config): string {
  const persistable = toPersistable(cfg);
  return `${JSON.stringify(persistable, null, 2)}\n`;
}

/**
 * Build the minimal object written to disk. Exported for tests / tooling that
 * want the same shape without touching the filesystem.
 */
export function toPersistable(cfg: Config): Record<string, unknown> {
  const defaults = defaultConfig();
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEY_ORDER) {
    const val = cfg[key];
    if (shouldOmit(key, val, defaults[key])) continue;
    out[key] = pruneNestedDefaults(key, val);
  }
  return out;
}

/** True when `val` is empty or equal to the schema default for `key`. */
function shouldOmit(key: keyof Config, val: unknown, def: unknown): boolean {
  // Always keep an explicit tooling_profile once chosen (including 'minimal')
  // so first-run detection stays accurate after the user has answered.
  if (key === 'tooling_profile') return val === undefined;
  // memory_provider 'off' is the default — omit so the file stays clean.
  if (key === 'memory_provider' && val === 'off') return true;
  if (val === undefined) return true;
  if (typeof val === 'string' && val === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  if (isPlainObject(val) && Object.keys(val).length === 0) return true;
  // Nested memory_provider_config defaults to all-empty strings — treat as empty.
  if (key === 'memory_provider_config' && isEmptyMemoryConfig(val)) return true;
  // Drop values equal to the filled schema default (streaming true, threshold 16000, …).
  if (stableEqual(val, def)) return true;
  return false;
}

function pruneNestedDefaults(key: keyof Config, val: unknown): unknown {
  if (key !== 'memory_provider_config' || !isPlainObject(val)) return val;
  // Only persist the non-empty fields of the memory provider bucket.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) cleaned[k] = v;
  }
  return cleaned;
}

function isEmptyMemoryConfig(val: unknown): boolean {
  if (!isPlainObject(val)) return false;
  return Object.values(val).every((v) => v === '' || v === undefined);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Parse config file text. Accepts strict JSON and a practical JSONC subset:
 *   • // line comments
 *   • /* block comments *\/
 * Strings are respected so URLs containing // are not mangled.
 */
export function parseConfigText(text: string): unknown {
  const stripped = stripJsonComments(text);
  return JSON.parse(stripped);
}

/** Strip // and /* *\/ comments outside of JSON strings. */
export function stripJsonComments(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;
  while (i < input.length) {
    const ch = input[i] ?? '';
    const next = input[i + 1] ?? '';
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringQuote = '"';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      // Line comment — skip to end of line (keep the newline so line numbers
      // in parse errors stay roughly useful).
      i += 2;
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      if (i + 1 < input.length)
        i += 2; // consume */
      else i = input.length; // unclosed block comment → EOF
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Drop `$…` / `_…` documentation keys so hand-annotated configs still load. */
function stripDocKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$') || k.startsWith('_') || k.startsWith('//')) continue;
    out[k] = v;
  }
  return out;
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join('.') : '(root)';
      return `${path}: ${iss.message}`;
    })
    .join('; ');
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- Test helper ----------

/** Returns an empty Config with all defaults filled in. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * Example skeleton for docs / first-run guidance. Not written automatically —
 * operators can copy it into ~/.pentesterflow/config.json and fill values.
 */
export const EXAMPLE_CONFIG_JSON = `{
  // LLM provider — ollama | lmstudio | openai | openai-compat | kimi | groq |
  // openrouter | deepseek | gemini | anthropic | naraya | dahl
  "backend": "ollama",
  "model": "qwen2.5-coder:14b",
  // "base_url": "http://localhost:11434",
  // "api_key": "",

  // Remembered custom model ids (fine-tunes, proxy renames, …)
  // "custom_models": ["my-ft:abc"],

  // "tooling_profile": "minimal",   // or "full" for scanners
  // "streaming_enabled": true,
  // "thinking_enabled": false,
  // "max_steps": 20,
  // "auto_compact_threshold": 16000,
  // "temperature": 0.2,
  // "max_tokens": 4096,

  // "skills_dirs": ["./my-skills"],
  // "disabled_skills": [],

  // "mcp_servers": [
  //   { "name": "my-mcp", "command": "npx", "args": ["-y", "some-mcp@latest"] }
  // ],

  // Custom OpenAI-scheme gateway:
  // "backend": "openai-compat",
  // "base_url": "http://127.0.0.1:8000/v1",
  // "api_key": "sk-local",
  // "model": "my-model"

  // Custom Anthropic-scheme gateway:
  // "backend": "anthropic",
  // "base_url": "https://proxy.example.com/v1",
  // "api_key": "sk-ant-…",
  // "model": "claude-sonnet-5"
}
`;
