import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/config.js';
import { newFromConfig } from './factory.js';

describe('newFromConfig', () => {
  it('creates a Kimi client with Moonshot defaults', () => {
    const cfg = defaultConfig();
    cfg.backend = 'kimi';
    cfg.api_key = 'sk-kimi';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('kimi');
    expect(client.model()).toBe('kimi-k2.6');
  });

  it('requires a Kimi API key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'kimi';

    expect(() => newFromConfig(cfg)).toThrow(/MOONSHOT_API_KEY/);
  });

  it('creates a Groq client with defaults', () => {
    const cfg = defaultConfig();
    cfg.backend = 'groq';
    cfg.api_key = 'gsk-test';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('groq');
    expect(client.model()).toBe('openai/gpt-oss-20b');
  });

  it('requires a Groq API key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'groq';

    expect(() => newFromConfig(cfg)).toThrow(/GROQ_API_KEY/);
  });

  it('creates an OpenRouter client with defaults', () => {
    const cfg = defaultConfig();
    cfg.backend = 'openrouter';
    cfg.api_key = 'sk-or-test';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('openrouter');
    expect(client.model()).toBe('openrouter/auto');
  });

  it('requires an OpenRouter API key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'openrouter';

    expect(() => newFromConfig(cfg)).toThrow(/OPENROUTER_API_KEY/);
  });

  it('creates a DeepSeek client with defaults', () => {
    const cfg = defaultConfig();
    cfg.backend = 'deepseek';
    cfg.api_key = 'sk-deepseek-test';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('deepseek');
    expect(client.model()).toBe('deepseek-v4-flash');
  });

  it('requires a DeepSeek API key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'deepseek';

    expect(() => newFromConfig(cfg)).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('creates a Gemini client with defaults', () => {
    const cfg = defaultConfig();
    cfg.backend = 'gemini';
    cfg.api_key = 'gemini-test';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('gemini');
    expect(client.model()).toBe('models/gemini-3.5-flash');
  });

  it('requires a Gemini API key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'gemini';

    expect(() => newFromConfig(cfg)).toThrow(/GEMINI_API_KEY/);
  });

  it('uses ollama_base_url from config when base_url is empty', () => {
    const cfg = defaultConfig();
    cfg.backend = 'ollama';
    cfg.ollama_base_url = 'http://192.168.1.5:11434';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('ollama');
    expect((client as { baseURL: string }).baseURL).toBe('http://192.168.1.5:11434');
  });
});
