// Known remote providers aligned with OpenCode's provider catalog
// (https://github.com/anomalyco/opencode/tree/dev/packages/core/src/plugin/provider)
// and models.opencode.ai. Most are OpenAI Chat Completions–compatible and
// reuse OpenAIClient with a fixed base URL + env key.
//
// Complex auth providers (Azure resource naming, AWS Bedrock, GitHub Copilot
// OAuth, Vertex ADC) are intentionally omitted — use openai-compat or
// anthropic custom schemes for those.

export type ProviderScheme = 'openai' | 'anthropic' | 'gemini' | 'local';

export interface ProviderDef {
  /** Backend id stored in config.json */
  id: string;
  /** Human label in /provider picker */
  name: string;
  /** Wire protocol used by our clients */
  scheme: ProviderScheme;
  /** Default API base URL (may be empty for local or special clients) */
  baseURL: string;
  /** Preferred env var(s); first is shown in help / empty-key error */
  envKeys: readonly string[];
  /** Curated model ids floated in the picker (live /models still wins) */
  models: readonly string[];
  /** Default model when config.model is empty */
  defaultModel: string;
  /** Extra request headers (OpenRouter-style attribution, etc.) */
  headers?: Record<string, string>;
  /** Short description for the picker */
  description: string;
}

/** OpenAI-compatible presets from OpenCode plugin list + public base URLs. */
export const OPENAI_SCHEME_PROVIDERS: readonly ProviderDef[] = [
  {
    id: 'xai',
    name: 'xAI',
    scheme: 'openai',
    baseURL: 'https://api.x.ai/v1',
    envKeys: ['XAI_API_KEY'],
    defaultModel: 'grok-4.5',
    models: [
      'grok-4.5',
      'grok-4.3',
      'grok-build-0.1',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
    ],
    description: 'remote — api.x.ai (Grok)',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    scheme: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    envKeys: ['MISTRAL_API_KEY'],
    defaultModel: 'mistral-large-2411',
    models: [
      'mistral-large-2411',
      'mistral-medium-2508',
      'mistral-small-2506',
      'magistral-medium-latest',
      'codestral-latest',
      'pixtral-large-latest',
      'open-mixtral-8x22b',
      'open-mistral-nemo',
    ],
    description: 'remote — api.mistral.ai',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    scheme: 'openai',
    baseURL: 'https://api.cerebras.ai/v1',
    envKeys: ['CEREBRAS_API_KEY'],
    defaultModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'llama-3.3-70b', 'qwen-3-32b', 'gemma-4-31b', 'zai-glm-4.7'],
    headers: { 'X-Cerebras-3rd-Party-Integration': 'pentesterflow' },
    description: 'remote — api.cerebras.ai',
  },
  {
    id: 'togetherai',
    name: 'Together AI',
    scheme: 'openai',
    baseURL: 'https://api.together.xyz/v1',
    envKeys: ['TOGETHER_API_KEY'],
    defaultModel: 'openai/gpt-oss-120b',
    models: [
      'openai/gpt-oss-120b',
      'moonshotai/Kimi-K2-Instruct',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'google/gemma-4-31B-it',
      'zai-org/GLM-5.2',
    ],
    description: 'remote — api.together.xyz',
  },
  {
    id: 'runcrate',
    name: 'Runcrate',
    scheme: 'openai',
    baseURL: 'https://api.runcrate.ai/v1',
    envKeys: ['RUNCRATE_API_KEY'],
    defaultModel: 'deepseek-ai/DeepSeek-V3.2',
    models: [
      'deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-R1-0528',
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
      'moonshotai/Kimi-K2.6',
      'zai-org/GLM-5.2',
      'openai/gpt-oss-120b',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    ],
    description: 'remote — api.runcrate.ai',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    scheme: 'openai',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    envKeys: ['DEEPINFRA_API_KEY'],
    defaultModel: 'deepseek-ai/DeepSeek-V3.2',
    models: [
      'deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-V3.1',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'meta-llama/Meta-Llama-3.1-405B-Instruct',
      'google/gemma-4-31B-it',
      'zai-org/GLM-5',
    ],
    description: 'remote — api.deepinfra.com',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    scheme: 'openai',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    envKeys: ['FIREWORKS_API_KEY'],
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
      'accounts/fireworks/models/kimi-k2-instruct',
    ],
    description: 'remote — api.fireworks.ai',
  },
  {
    id: 'baseten',
    name: 'Baseten',
    scheme: 'openai',
    baseURL: 'https://inference.baseten.co/v1',
    envKeys: ['BASETEN_API_KEY'],
    defaultModel: 'zai-org/GLM-5.2',
    models: [
      'zai-org/GLM-5.2',
      'zai-org/GLM-5.1',
      'zai-org/GLM-5',
      'thinkingmachines/inkling',
      'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
    ],
    description: 'remote — inference.baseten.co',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    scheme: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    envKeys: ['NVIDIA_API_KEY'],
    defaultModel: 'meta/llama-3.3-70b-instruct',
    models: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'nvidia/nemotron-3-nano-30b-a3b',
      'deepseek-ai/deepseek-r1',
      'qwen/qwen3-coder-480b-a35b-instruct',
    ],
    headers: {
      'HTTP-Referer': 'https://github.com/pentesterflow/agent',
      'X-Title': 'PentesterFlow',
    },
    description: 'remote — integrate.api.nvidia.com',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    scheme: 'openai',
    baseURL: 'https://api.perplexity.ai',
    envKeys: ['PERPLEXITY_API_KEY'],
    defaultModel: 'sonar-pro',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-deep-research'],
    description: 'remote — api.perplexity.ai',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    scheme: 'openai',
    baseURL: 'https://api.cohere.ai/compatibility/v1',
    envKeys: ['COHERE_API_KEY'],
    defaultModel: 'command-a-03-2025',
    models: [
      'command-a-03-2025',
      'command-a-reasoning-08-2025',
      'command-r-plus-08-2024',
      'command-r-08-2024',
      'command-r7b-12-2024',
    ],
    description: 'remote — api.cohere.ai (OpenAI-compat path)',
  },
  {
    id: 'alibaba',
    name: 'Alibaba',
    scheme: 'openai',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKeys: ['DASHSCOPE_API_KEY', 'ALIBABA_API_KEY'],
    defaultModel: 'qwen3-coder-480b-a35b-instruct',
    models: [
      'qwen3-coder-480b-a35b-instruct',
      'qwen3.7-plus',
      'qwen3.7-max',
      'qwen3-max',
      'qwen3-32b',
      'qwen-max',
      'qwen3.5-plus',
      'deepseek-v4-flash',
    ],
    description: 'remote — DashScope international (Qwen)',
  },
  {
    id: 'venice',
    name: 'Venice AI',
    scheme: 'openai',
    baseURL: 'https://api.venice.ai/api/v1',
    envKeys: ['VENICE_API_KEY'],
    defaultModel: 'qwen3-coder-480b-a35b-instruct-turbo',
    models: [
      'qwen3-coder-480b-a35b-instruct-turbo',
      'deepseek-v3.2',
      'grok-4-5',
      'claude-sonnet-4-6',
      'qwen3-5-397b-a17b',
    ],
    description: 'remote — api.venice.ai (uncensored-friendly)',
  },
  {
    id: 'zenmux',
    name: 'ZenMux',
    scheme: 'openai',
    baseURL: 'https://zenmux.ai/api/v1',
    envKeys: ['ZENMUX_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-4-6',
    models: [
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-8',
      'google/gemini-3.5-flash',
      'openai/gpt-4.1',
      'deepseek/deepseek-v4-pro',
    ],
    headers: {
      'HTTP-Referer': 'https://github.com/pentesterflow/agent',
      'X-Title': 'PentesterFlow',
    },
    description: 'remote — zenmux.ai multi-vendor gateway',
  },
  {
    id: 'kilo',
    name: 'Kilo Gateway',
    scheme: 'openai',
    baseURL: 'https://api.kilo.ai/api/gateway',
    envKeys: ['KILO_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-4-6',
    models: [
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-4.1',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-chat',
    ],
    headers: {
      'HTTP-Referer': 'https://github.com/pentesterflow/agent',
      'X-Title': 'PentesterFlow',
    },
    description: 'remote — api.kilo.ai gateway',
  },
  {
    id: 'llmgateway',
    name: 'LLM Gateway',
    scheme: 'openai',
    baseURL: 'https://api.llmgateway.io/v1',
    envKeys: ['LLMGATEWAY_API_KEY'],
    defaultModel: 'gpt-4.1',
    models: [
      'gpt-4.1',
      'claude-sonnet-4-6',
      'gemini-2.5-pro',
      'qwen3-coder-480b-a35b-instruct',
      'deepseek-v4-flash',
      'grok-4',
    ],
    headers: {
      'HTTP-Referer': 'https://github.com/pentesterflow/agent',
      'X-Title': 'PentesterFlow',
      'X-Source': 'pentesterflow',
    },
    description: 'remote — api.llmgateway.io',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    scheme: 'openai',
    baseURL: 'https://opencode.ai/zen/v1',
    envKeys: ['OPENCODE_API_KEY'],
    defaultModel: 'claude-sonnet-4-6',
    models: [
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'gpt-5.5-pro',
      'gemini-3.5-flash',
      'glm-5',
      'gpt-5.1-codex-mini',
    ],
    description: 'remote — opencode.ai/zen',
  },
] as const;

const byId = new Map(OPENAI_SCHEME_PROVIDERS.map((p) => [p.id, p]));

export function getOpenAISchemeProvider(id: string): ProviderDef | undefined {
  return byId.get(id);
}

export function isOpenAISchemeProvider(id: string): boolean {
  return byId.has(id);
}

export function openaiSchemeBackendIds(): string[] {
  return OPENAI_SCHEME_PROVIDERS.map((p) => p.id);
}
