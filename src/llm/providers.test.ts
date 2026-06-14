import { describe, expect, it } from 'vitest';
import {
  KIMI_CONTEXT_WINDOWS,
  KIMI_DEFAULT_MODEL,
  KIMI_MODELS,
  kimiAutoCompactThreshold,
  kimiLocksTemperature,
  kimiSupportsThinkingToggle,
} from './providers.js';

describe('kimiLocksTemperature', () => {
  it('flags k2.7-code / k2.6 / k2.5 (provider rejects temperature != 1)', () => {
    expect(kimiLocksTemperature('kimi-k2.7-code')).toBe(true);
    expect(kimiLocksTemperature('kimi-k2.6')).toBe(true);
    expect(kimiLocksTemperature('kimi-k2.5')).toBe(true);
  });
  it('allows temperature on moonshot-v1 models and others', () => {
    expect(kimiLocksTemperature('moonshot-v1-8k')).toBe(false);
    expect(kimiLocksTemperature('moonshot-v1-128k')).toBe(false);
    expect(kimiLocksTemperature('qwen-coder')).toBe(false);
  });
});

describe('kimiSupportsThinkingToggle', () => {
  it('only enables the thinking toggle for Kimi K2.6 / K2.5', () => {
    expect(kimiSupportsThinkingToggle('kimi-k2.6')).toBe(true);
    expect(kimiSupportsThinkingToggle('kimi-k2.5')).toBe(true);
    // k2.7-code always thinks (mandatory) — no toggle to expose.
    expect(kimiSupportsThinkingToggle('kimi-k2.7-code')).toBe(false);
    expect(kimiSupportsThinkingToggle('moonshot-v1-8k')).toBe(false);
    expect(kimiSupportsThinkingToggle('moonshot-v1-128k')).toBe(false);
  });
});

describe('kimiAutoCompactThreshold', () => {
  it('sizes the threshold to 75% of the model context window', () => {
    // kimi-k2.6 / k2.5 are 256K → ~196K, well above the 16K generic default.
    expect(kimiAutoCompactThreshold('kimi-k2.6')).toBe(Math.floor(262144 * 0.75));
    expect(kimiAutoCompactThreshold('kimi-k2.5')).toBe(196608);
    expect(kimiAutoCompactThreshold('moonshot-v1-128k')).toBe(98304);
    expect(kimiAutoCompactThreshold('moonshot-v1-32k')).toBe(24576);
  });

  it('tightens the 8K model below the 16K generic default (avoids overflow)', () => {
    const t = kimiAutoCompactThreshold('moonshot-v1-8k');
    expect(t).toBe(6144);
    expect(t).toBeLessThan(16000);
  });

  it('returns undefined for unknown models so the caller keeps its default', () => {
    expect(kimiAutoCompactThreshold('some-future-model')).toBeUndefined();
    expect(kimiAutoCompactThreshold('')).toBeUndefined();
  });

  it('never exceeds the model context window', () => {
    for (const [model, window] of Object.entries(KIMI_CONTEXT_WINDOWS)) {
      const t = kimiAutoCompactThreshold(model);
      expect(t).toBeDefined();
      expect(t as number).toBeLessThan(window);
    }
  });

  it('knows the window for the default Kimi model and every listed model', () => {
    expect(KIMI_CONTEXT_WINDOWS[KIMI_DEFAULT_MODEL]).toBe(262144);
    for (const model of KIMI_MODELS) {
      expect(KIMI_CONTEXT_WINDOWS[model], `missing context window for ${model}`).toBeGreaterThan(0);
    }
  });
});
