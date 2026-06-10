// Fetch the list of available models from an LLM backend. Used by the
// interactive /provider flow to populate the model picker after the user
// chooses Ollama / LM Studio / openai-compat / Kimi / Groq / OpenRouter / DeepSeek / Gemini.

import type { Backend } from '../config/config.js';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_MODELS,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_RECOMMENDED_MODELS,
  GROQ_DEFAULT_BASE_URL,
  GROQ_MODELS,
  KIMI_DEFAULT_BASE_URL,
  KIMI_MODELS,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_RECOMMENDED_MODELS,
} from './providers.js';

const DEFAULT_TIMEOUT_MS = 5_000;

const DEFAULT_BASE_URL: Record<Exclude<Backend, ''>, string> = {
  ollama: 'http://172.16.205.200:11434',
  lmstudio: 'http://172.16.205.200:1234/v1',
  'openai-compat': '',
  kimi: KIMI_DEFAULT_BASE_URL,
  groq: GROQ_DEFAULT_BASE_URL,
  openrouter: OPENROUTER_DEFAULT_BASE_URL,
  deepseek: DEEPSEEK_DEFAULT_BASE_URL,
  gemini: GEMINI_DEFAULT_BASE_URL,
};

/**
 * Query the backend's model-list endpoint and return the IDs. Throws
 * on transport failure or non-2xx. Trips a 5-second timeout so a stalled
 * endpoint doesn't wedge the UI.
 *
 *   ollama        → GET <base>/api/tags  → { models: [{ name }] }
 *   lmstudio      → GET <base>/models    → { data:   [{ id   }] }
 *   openai-compat → GET <base>/models    → same as lmstudio (Bearer header)
 *   kimi          → GET <base>/models    → same as openai-compat (Bearer header)
 *   groq          → GET <base>/models    → same as openai-compat (Bearer header)
 *   openrouter    → GET <base>/models    → same as openai-compat (Bearer header)
 *   deepseek      → GET <base>/models    → same as openai-compat (Bearer header)
 *   gemini        → GET <base>/models?key=... → { models: [{ name }] }
 */
export async function listModels(
  backend: Backend,
  baseURL = '',
  apiKey = '',
  signal?: AbortSignal,
): Promise<string[]> {
  const b: Exclude<Backend, ''> = backend === '' ? 'ollama' : backend;
  const base = baseURL || DEFAULT_BASE_URL[b];
  if (!base) throw new Error(`${b} backend requires a base URL`);

  const path = b === 'ollama' ? '/api/tags' : b === 'gemini' ? '/models' : '/models';
  const headers: Record<string, string> = {};
  if (apiKey && b !== 'ollama' && b !== 'gemini') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const suffix = b === 'gemini' ? `?key=${encodeURIComponent(apiKey)}` : '';
    const resp = await fetch(`${base}${path}${suffix}`, {
      method: 'GET',
      headers,
      signal: ctl.signal,
    });
    if (resp.status !== 200) {
      throw new Error(`${b} list-models returned ${resp.status}`);
    }
    const body = (await resp.json()) as unknown;
    return parseModels(b, body);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseModels(backend: Exclude<Backend, ''>, body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  if (backend === 'ollama') {
    const models = (body as { models?: Array<{ name?: unknown }> }).models ?? [];
    return models
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n): n is string => n.length > 0);
  }
  if (backend === 'gemini') {
    const models =
      (body as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> })
        .models ?? [];
    const names = models
      .filter((m) => {
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? m.supportedGenerationMethods
          : [];
        return methods.includes('generateContent');
      })
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n): n is string => n.length > 0);
    return preferGeminiRecommended(names);
  }
  const data = (body as { data?: Array<{ id?: unknown }> }).data ?? [];
  const ids = data
    .map((m) => (typeof m.id === 'string' ? m.id : ''))
    .filter((n): n is string => n.length > 0);
  if (backend === 'kimi') return preferKnownModels(ids, KIMI_MODELS);
  if (backend === 'groq') return preferKnownModels(ids, GROQ_MODELS);
  if (backend === 'openrouter') {
    return preferOpenRouterModels(ids);
  }
  if (backend === 'deepseek') return preferKnownModels(ids, DEEPSEEK_MODELS);
  return ids;
}

function preferGeminiRecommended(models: string[]): string[] {
  return preferKnownModels(models, GEMINI_RECOMMENDED_MODELS, { appendUnknown: true });
}

function preferOpenRouterModels(models: string[]): string[] {
  const withAuto = models.includes('openrouter/auto')
    ? models
    : [...OPENROUTER_RECOMMENDED_MODELS, ...models];
  return preferKnownModels(withAuto, OPENROUTER_RECOMMENDED_MODELS, { appendUnknown: true });
}

function preferKnownModels(
  models: string[],
  known: readonly string[],
  opts: { appendUnknown?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of known) {
    if (models.includes(m) && !seen.has(m)) {
      out.push(m);
      seen.add(m);
    }
  }
  if (!opts.appendUnknown) return out;
  for (const m of models) {
    if (!seen.has(m)) {
      out.push(m);
      seen.add(m);
    }
  }
  return out;
}
