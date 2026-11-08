import type { Backend } from '../config/config.js';

export function modelReliabilityWarning(backend: Backend, model: string): string | undefined {
  const size = inferModelBillions(model);
  if (size === undefined) return undefined;

  const normalizedBackend = backend || 'ollama';
  if ((normalizedBackend === 'ollama' || normalizedBackend === 'lmstudio') && size < 14) {
    return `⚠  model ${model}: ${formatBillions(size)} local models may not reliably emit executable tool calls. Recommended minimum: 14b locally, or 70b+ for hosted providers.`;
  }
  // First-party frontier APIs (Claude, Gemini, Kimi, official OpenAI, DeepSeek
  // V4) ship agentic models that aren't sized like open-weight "Xb" labels —
  // a "26b" Gemma suffix or similar is not a useful reliability signal there.
  if (
    normalizedBackend === 'anthropic' ||
    normalizedBackend === 'gemini' ||
    normalizedBackend === 'kimi' ||
    normalizedBackend === 'openai' ||
    normalizedBackend === 'deepseek'
  ) {
    return undefined;
  }
  // Hosted open-weight style APIs (Groq, OpenRouter, OpenCode presets, …).
  const openWeightHosted =
    normalizedBackend === 'openai-compat' ||
    normalizedBackend === 'groq' ||
    normalizedBackend === 'openrouter' ||
    normalizedBackend === 'naraya' ||
    normalizedBackend === 'dahl' ||
    // OpenCode-aligned presets (xai/mistral/together/…); size heuristic still useful
    // for open-weight model names on those hosts.
    [
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
    ].includes(normalizedBackend);
  if (openWeightHosted && size < 70) {
    return `⚠  model ${model}: if this is a hosted API, sub-70b models may be unreliable for agentic tool calls. Recommended hosted size: 70b+.`;
  }
  return undefined;
}

export function inferModelBillions(model: string): number | undefined {
  const normalized = model.toLowerCase();
  const matches = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*b(?:$|[^a-z0-9])/gi)];
  if (matches.length === 0) return undefined;
  const sizes = matches
    .map((m) => (m[1] ? Number.parseFloat(m[1]) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  if (sizes.length === 0) return undefined;
  // Use the largest size found. Some model names include variant suffixes like
  // "-a3b", "distill-8b", or "mini-3b" after the main parameter count (e.g.
  // "qwen3.6-35b-a3b-..."). Taking the max avoids false "tiny model" warnings.
  return Math.max(...sizes);
}

function formatBillions(n: number): string {
  return Number.isInteger(n) ? `${n}b` : `${n.toFixed(1)}b`;
}
