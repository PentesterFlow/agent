// Config file at ~/.pentesterflow/config.json. Loaded once at startup; saved atomically (write to
// sibling .tmp + fsync + rename) so a crash mid-write can't corrupt it.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

// ---------- Schema ----------

const Backend = z.enum([
  '',
  'ollama',
  'lmstudio',
  'openai-compat',
  'kimi',
  'groq',
  'openrouter',
  'deepseek',
  'gemini',
]);
export type Backend = z.infer<typeof Backend>;

const MCPServerConfig = z.object({
  name: z.string().min(1),
  command: z.string().min(1).refine(noShellMeta, {
    message: 'mcp_servers[].command must not contain shell metacharacters',
  }),
  args: z.array(z.string()).default([]),
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

/** Schema default for auto_compact_threshold. Exported so backend-specific
 *  overrides (e.g. large-context Kimi models) can detect "user is on the
 *  default" and size the threshold to the model's real context window. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 16000;

/** Default Ollama API base when not overridden in ~/.pentesterflow/config.json. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
/** Default LM Studio OpenAI-compatible base when not overridden in config. */
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';

const ConfigSchema = z.object({
  backend: Backend.default(''),
  model: z.string().default(''),
  base_url: z.string().default(''),
  // Per-backend local endpoint defaults. Used when base_url is empty or when
  // listing models for a backend other than the active one.
  ollama_base_url: z.string().default(DEFAULT_OLLAMA_BASE_URL),
  lmstudio_base_url: z.string().default(DEFAULT_LMSTUDIO_BASE_URL),
  api_key: z.string().default(''),
  skills_dirs: z.array(z.string()).default([]),
  // Skill names the user has disabled via /skills. Hidden from the system
  // prompt and refused by load_skill until re-enabled. Persisted so the
  // selection survives restarts.
  disabled_skills: z.array(z.string()).default([]),
  mcp_servers: z.array(MCPServerConfig).default([]),
  plugins: z.array(PluginConfig).default([]),
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
  // Tooling profile: which tools the agent reaches for by default.
  //   'minimal' — curl + Unix only (jq, grep, awk, sed, head, sort, uniq).
  //   'full'    — adds ffuf, nuclei, sqlmap, gobuster, subfinder, httpx,
  //               wfuzz, masscan when locally available.
  // Undefined means the user hasn't been asked yet — the CLI triggers a
  // one-time first-run picker in that case and writes the answer back.
  tooling_profile: ToolingProfile.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

function noShellMeta(s: string): boolean {
  // Rejection set: any of these in a command path
  // is almost always an injection attempt rather than a real binary name.
  return !/[|&;<>$`\\\n]/.test(s) && !s.includes('$(') && !s.includes('${');
}

// ---------- Paths ----------

/** User-global config path (recommended for installed binaries). */
export function canonicalConfigPath(): string {
  const override = process.env.PENTESTERFLOW_CONFIG;
  if (override && override.length > 0) return resolve(override);
  return join(homedir(), '.pentesterflow', 'config.json');
}

/** Paths checked in order when PENTESTERFLOW_CONFIG is not set. */
export function configSearchPaths(cwd = process.cwd()): string[] {
  return [
    join(cwd, '.pentesterflow', 'config.json'),
    join(cwd, 'config.json'),
    join(homedir(), '.pentesterflow', 'config.json'),
  ];
}

/** @deprecated Use canonicalConfigPath() or loadedConfigPath(). */
export function configPath(): string {
  return loadedConfigPath() ?? canonicalConfigPath();
}

let activeConfigPath: string | undefined;

/** Absolute path of the config file used by the current process, if load() succeeded. */
export function loadedConfigPath(): string | undefined {
  return activeConfigPath;
}

export class ConfigNotFoundError extends Error {
  readonly searched: readonly string[];

  constructor(searched: readonly string[]) {
    super('config file not found');
    this.name = 'ConfigNotFoundError';
    this.searched = searched;
  }

  formatMessage(): string {
    const recommended = join(homedir(), '.pentesterflow', 'config.json');
    return [
      'pentesterflow: config file not found.',
      '',
      'PentesterFlow needs a config.json with your LLM settings (backend, model, endpoints).',
      '',
      'Searched:',
      ...this.searched.map((p) => `  - ${p}`),
      '',
      `Recommended location (persists across installs): ${recommended}`,
      '',
      'Example config.json:',
      '{',
      '  "backend": "ollama",',
      '  "model": "qwen2.5-coder:32b",',
      '  "ollama_base_url": "http://localhost:11434",',
      '  "lmstudio_base_url": "http://localhost:1234/v1"',
      '}',
      '',
      'Or point at a specific file:',
      '  PENTESTERFLOW_CONFIG=C:\\path\\to\\config.json pentesterflow',
    ].join('\n');
  }
}

function resolveConfigLoadPath(): string {
  const envOverride = process.env.PENTESTERFLOW_CONFIG;
  if (envOverride && envOverride.length > 0) {
    const path = resolve(envOverride);
    if (!existsSync(path)) {
      throw new ConfigNotFoundError([path]);
    }
    return path;
  }
  const searched = configSearchPaths();
  for (const path of searched) {
    if (existsSync(path)) return path;
  }
  throw new ConfigNotFoundError(searched);
}

function configSavePath(): string {
  if (activeConfigPath) return activeConfigPath;
  return canonicalConfigPath();
}

// ---------- Load / save ----------

export function load(): Config {
  const path = resolveConfigLoadPath();
  activeConfigPath = path;
  let raw: unknown;
  try {
    const buf = readFileSync(path, 'utf8');
    raw = JSON.parse(buf);
  } catch (err) {
    throw new Error(`config: failed to read ${path}: ${stringifyError(err)}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`config: ${path}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Atomically save the config: write to a sibling .tmp file with O_EXCL +
 * 0o600 from the moment of creation (no readable window), fsync, then
 * rename. Cleans up the .tmp on any error path.
 */
export async function save(cfg: Config): Promise<void> {
  const path = configSavePath();
  activeConfigPath = path;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const body = `${JSON.stringify(cfg, null, 2)}\n`;
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

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- Test helper ----------

/** Returns an empty Config with all defaults filled in. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * Resolve the effective API base URL for a backend.
 * `base_url` overrides the active backend only; other backends use their
 * dedicated config fields (ollama_base_url / lmstudio_base_url).
 */
export function resolveBackendBaseUrl(cfg: Config, backend?: Backend): string {
  const b: Exclude<Backend, ''> =
    backend === undefined || backend === '' ? (cfg.backend === '' ? 'ollama' : cfg.backend) : backend;
  const isActive =
    b === cfg.backend || (b === 'ollama' && (cfg.backend === '' || cfg.backend === 'ollama'));
  if (isActive && cfg.base_url) return cfg.base_url;
  switch (b) {
    case 'ollama':
      return cfg.ollama_base_url;
    case 'lmstudio':
      return cfg.lmstudio_base_url;
    default:
      return cfg.base_url;
  }
}
