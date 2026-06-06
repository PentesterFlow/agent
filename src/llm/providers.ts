export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_DEFAULT_MODEL = 'kimi-k2.6';
export const KIMI_MODELS = [
  'kimi-k2.6',
  'kimi-k2.5',
  'moonshot-v1-auto',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
  'moonshot-v1-8k-vision-preview',
  'moonshot-v1-32k-vision-preview',
  'moonshot-v1-128k-vision-preview',
];

// Context windows (tokens) for hosted Kimi/Moonshot models, from
// GET https://api.moonshot.ai/v1/models. kimi-k2.6 / k2.5 are 256K — far
// larger than the generic 16K auto-compact default — so we size the
// compaction threshold off the real window instead of throttling the model.
export const KIMI_CONTEXT_WINDOWS: Record<string, number> = {
  'kimi-k2.6': 262144,
  'kimi-k2.5': 262144,
  'moonshot-v1-auto': 131072,
  'moonshot-v1-128k': 131072,
  'moonshot-v1-128k-vision-preview': 131072,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-32k-vision-preview': 32768,
  'moonshot-v1-8k': 8192,
  'moonshot-v1-8k-vision-preview': 8192,
};

// kimi-k2.6 / k2.5 reject any `temperature` other than 1 — the API returns
// `400 invalid temperature: only 1 is allowed for this model`. The other
// moonshot-v1-* models accept a normal range. Used to decide whether it's
// safe to send a configured temperature.
export function kimiLocksTemperature(model: string): boolean {
  return model === 'kimi-k2.6' || model === 'kimi-k2.5';
}

export function kimiSupportsThinkingToggle(model: string): boolean {
  return model === 'kimi-k2.6' || model === 'kimi-k2.5';
}

// Default per-response token cap for Kimi. These models can't be slowed down
// via temperature (it's locked to 1), so an unbounded response lets them
// narrate for a long time. Capping each turn keeps the agent responsive;
// it's generous enough for a substantive step + tool call and is overridable
// via config `max_tokens`.
export const KIMI_DEFAULT_MAX_TOKENS = 2048;

/**
 * Recommended auto-compact threshold for a Kimi model: 75% of its context
 * window, leaving headroom for the response and the next round of tool
 * output before the hard context limit. Returns undefined for unknown models
 * (caller keeps the configured default). Note this also tightens the small
 * 8K model, where the generic 16K default exceeds the window and would let
 * the conversation silently overflow.
 */
export function kimiAutoCompactThreshold(model: string): number | undefined {
  const window = KIMI_CONTEXT_WINDOWS[model];
  if (window === undefined) return undefined;
  return Math.floor(window * 0.75);
}

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';
export const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen/qwen3-32b',
  'deepseek-r1-distill-llama-70b',
  'compound-beta',
  'compound-beta-mini',
];

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openrouter/auto';
export const OPENROUTER_RECOMMENDED_MODELS = ['openrouter/auto'];

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
];

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'models/gemini-3.5-flash';

export const GEMINI_BEST_FIT_MODELS = [
  'models/gemini-3.5-flash',
  'models/gemini-flash-latest',
  'models/gemini-3-flash-preview',
  'models/gemini-3.1-flash-lite',
  'models/gemini-2.5-flash-lite',
];

export const GEMINI_CHEAP_MODELS = [
  'models/gemini-flash-lite-latest',
  'models/gemini-3.1-flash-lite-preview',
  'models/gemma-4-26b-a4b-it',
];

export const GEMINI_RECOMMENDED_MODELS = [...GEMINI_BEST_FIT_MODELS, ...GEMINI_CHEAP_MODELS];
