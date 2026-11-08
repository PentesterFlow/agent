import { describe, expect, it } from 'vitest';
import { BACKENDS } from '../config/config.js';
import {
  OPENAI_SCHEME_PROVIDERS,
  getOpenAISchemeProvider,
  isOpenAISchemeProvider,
  openaiSchemeBackendIds,
} from './providerRegistry.js';

describe('providerRegistry (OpenCode-aligned)', () => {
  it('registers every OpenAI-scheme preset with a base URL and env key', () => {
    expect(OPENAI_SCHEME_PROVIDERS.length).toBeGreaterThanOrEqual(10);
    for (const p of OPENAI_SCHEME_PROVIDERS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.baseURL).toMatch(/^https?:\/\//);
      expect(p.envKeys.length).toBeGreaterThan(0);
      expect(p.defaultModel.length).toBeGreaterThan(0);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.models).toContain(p.defaultModel);
    }
  });

  it('exposes ids that are valid config backends', () => {
    for (const id of openaiSchemeBackendIds()) {
      expect(BACKENDS).toContain(id);
      expect(isOpenAISchemeProvider(id)).toBe(true);
      expect(getOpenAISchemeProvider(id)?.id).toBe(id);
    }
  });

  it('includes the main OpenCode plugin/provider names', () => {
    const ids = new Set(openaiSchemeBackendIds());
    for (const need of [
      'xai',
      'mistral',
      'cerebras',
      'togetherai',
      'deepinfra',
      'nvidia',
      'perplexity',
      'alibaba',
      'venice',
      'zenmux',
      'kilo',
      'llmgateway',
      'opencode',
    ]) {
      expect(ids.has(need), `missing ${need}`).toBe(true);
    }
  });

  it('registers Runcrate with its OpenAI-compatible endpoint and key', () => {
    const runcrate = getOpenAISchemeProvider('runcrate');
    expect(runcrate).toBeDefined();
    expect(runcrate?.scheme).toBe('openai');
    expect(runcrate?.baseURL).toBe('https://api.runcrate.ai/v1');
    expect(runcrate?.envKeys).toEqual(['RUNCRATE_API_KEY']);
    expect(runcrate?.models).toContain(runcrate?.defaultModel);
    expect(BACKENDS).toContain('runcrate');
  });
});
