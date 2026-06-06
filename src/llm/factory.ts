// Build the right Client from the parsed Config.

import type { Config } from '../config/config.js';
import type { Client } from './client.js';
import { GeminiClient } from './gemini.js';
import { OllamaClient } from './ollama.js';
import { OpenAIClient } from './openai.js';
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODEL,
  GROQ_DEFAULT_BASE_URL,
  GROQ_DEFAULT_MODEL,
  KIMI_DEFAULT_BASE_URL,
  KIMI_DEFAULT_MAX_TOKENS,
  KIMI_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
} from './providers.js';

export function newFromConfig(cfg: Config): Client {
  // Generation knobs shared by the OpenAI-compatible backends. temperature is
  // sent only to models that accept it (see OpenAIClient.encodeRequest).
  const gen = { temperature: cfg.temperature, maxTokens: cfg.max_tokens };
  switch (cfg.backend) {
    case 'ollama':
    case '':
      return new OllamaClient(cfg.base_url, cfg.model);
    case 'lmstudio':
      return OpenAIClient.lmStudio(cfg.base_url, cfg.model);
    case 'openai-compat':
      if (!cfg.base_url) {
        throw new Error('openai-compat backend requires base_url');
      }
      return new OpenAIClient(cfg.base_url, cfg.api_key, cfg.model, 'openai-compat', {}, gen);
    case 'kimi':
      if (!cfg.api_key) {
        throw new Error('kimi backend requires api_key or MOONSHOT_API_KEY');
      }
      return new OpenAIClient(
        cfg.base_url || KIMI_DEFAULT_BASE_URL,
        cfg.api_key,
        cfg.model || KIMI_DEFAULT_MODEL,
        'kimi',
        {},
        // Kimi can't be tuned down via temperature (locked to 1), so default a
        // response cap to keep it from narrating unbounded; user override wins.
        { temperature: cfg.temperature, maxTokens: cfg.max_tokens ?? KIMI_DEFAULT_MAX_TOKENS },
      );
    case 'groq':
      if (!cfg.api_key) {
        throw new Error('groq backend requires api_key or GROQ_API_KEY');
      }
      return new OpenAIClient(
        cfg.base_url || GROQ_DEFAULT_BASE_URL,
        cfg.api_key,
        cfg.model || GROQ_DEFAULT_MODEL,
        'groq',
        {},
        gen,
      );
    case 'openrouter':
      if (!cfg.api_key) {
        throw new Error('openrouter backend requires api_key or OPENROUTER_API_KEY');
      }
      return new OpenAIClient(
        cfg.base_url || OPENROUTER_DEFAULT_BASE_URL,
        cfg.api_key,
        cfg.model || OPENROUTER_DEFAULT_MODEL,
        'openrouter',
        {
          'HTTP-Referer': 'https://github.com/pentesterflow/agent',
          'X-OpenRouter-Title': 'PentesterFlow',
        },
        gen,
      );
    case 'deepseek':
      if (!cfg.api_key) {
        throw new Error('deepseek backend requires api_key or DEEPSEEK_API_KEY');
      }
      return new OpenAIClient(
        cfg.base_url || DEEPSEEK_DEFAULT_BASE_URL,
        cfg.api_key,
        cfg.model || DEEPSEEK_DEFAULT_MODEL,
        'deepseek',
        {},
        gen,
      );
    case 'gemini':
      if (!cfg.api_key) {
        throw new Error('gemini backend requires api_key or GEMINI_API_KEY');
      }
      return new GeminiClient(
        cfg.base_url || GEMINI_DEFAULT_BASE_URL,
        cfg.api_key,
        cfg.model || GEMINI_DEFAULT_MODEL,
      );
    default: {
      const _exhaustive: never = cfg.backend;
      throw new Error(`unknown backend: ${String(_exhaustive)}`);
    }
  }
}
