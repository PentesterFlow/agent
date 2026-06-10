import type { Backend } from '../config/config.js';

export function modelReliabilityWarning(backend: Backend, model: string): string | undefined {
  const size = inferModelBillions(model);
  if (size === undefined) return undefined;

  const normalizedBackend = backend || 'ollama';
  if ((normalizedBackend === 'ollama' || normalizedBackend === 'lmstudio') && size < 14) {
    return `⚠  model ${model}: ${formatBillions(size)} local models may not reliably emit executable tool calls. Recommended minimum: 14b locally, or 70b+ for hosted providers.`;
  }
  if (
    (normalizedBackend === 'openai-compat' ||
      normalizedBackend === 'kimi' ||
      normalizedBackend === 'groq' ||
      normalizedBackend === 'openrouter' ||
      normalizedBackend === 'deepseek' ||
      normalizedBackend === 'gemini') &&
    size < 70
  ) {
    return `⚠  model ${model}: if this is a hosted API, sub-70b models may be unreliable for agentic tool calls. Recommended hosted size: 70b+.`;
  }
  return undefined;
}

export function inferModelBillions(model: string): number | undefined {
  const normalized = model.toLowerCase();
  const matches = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*b(?:$|[^a-z0-9])/gi)];
  const size = matches.at(-1)?.[1];
  if (!size) return undefined;
  const n = Number.parseFloat(size);
  return Number.isFinite(n) ? n : undefined;
}

function formatBillions(n: number): string {
  return Number.isInteger(n) ? `${n}b` : `${n.toFixed(1)}b`;
}
