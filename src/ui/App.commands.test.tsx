// Integration tests for the UI-only slash commands that the headless
// command harness can't reach: /exit, /quit, /clear, /provider, /yolo.
// Mounts the real <App> with ink-testing-library and drives keystrokes.

import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent/agent.js';
import type { Client } from '../llm/client.js';
import { listModels } from '../llm/models.js';
import type { ChatResponse } from '../llm/types.js';
import { AlwaysAllow } from '../permission/permission.js';
import { newRegistry } from '../skills/registry.js';
import { Target } from '../target/target.js';
import { Registry as ToolRegistry } from '../tools/registry.js';
import { runSelfUpdate } from '../update/selfUpdate.js';
import { App, type AppProps } from './App.js';
import type { BannerData } from './Banner.js';
import { TerminalSizeProvider } from './TerminalSize.js';
import { EntryView } from './Transcript.js';
import type { TranscriptEntry } from './state.js';

vi.mock('../update/selfUpdate.js', () => ({
  runSelfUpdate: vi.fn(async () => ({
    version: 'latest',
    installDir: '/tmp/bin',
    output: 'installed pentesterflow',
  })),
}));

vi.mock('../llm/models.js', () => ({
  listModels: vi.fn(async () => ['qwen2.5-coder:14b', 'llama3.1:8b']),
}));

const stubClient: Client = {
  name: () => 'stub',
  model: () => 'stub-model',
  chat: async (): Promise<ChatResponse> => ({
    message: { role: 'assistant', content: '' },
    finishReason: 'stop',
  }),
};

const bannerData: BannerData = {
  provider: 'ollama',
  model: 'stub-model',
  state: 'local',
  cwd: '/tmp/engagement',
};

const tick = () => new Promise((r) => setTimeout(r, 50));

let agent: Agent;
let runSpy: ReturnType<typeof vi.fn>;
let setYolo: ReturnType<typeof vi.fn>;
let applyProvider: ReturnType<typeof vi.fn>;
let mounted: ReturnType<typeof render> | null = null;

function makeProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    agent,
    bannerData,
    parentSignal: new AbortController().signal,
    readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    applyProvider,
    setYolo,
    ...overrides,
  };
}

/** Mount <App> wrapped in the providers the CLI gives it. */
function renderApp(overrides: Partial<AppProps> = {}) {
  return render(
    <TerminalSizeProvider>
      <App {...makeProps(overrides)} />
    </TerminalSizeProvider>,
  );
}

/** Type a line and press Enter, letting React flush between writes. */
async function submit(stdin: { write: (s: string) => void }, line: string) {
  stdin.write(line);
  await tick();
  stdin.write('\r');
  await tick();
}

beforeEach(() => {
  const skills = newRegistry();
  skills.loadDir(join(process.cwd(), 'skills'));
  agent = new Agent({
    client: stubClient,
    tools: new ToolRegistry(),
    skills,
    prompter: new AlwaysAllow(),
    store: null,
    target: new Target(),
  });
  runSpy = vi.fn(async () => {});
  // Detect whether a submission was routed to the agent (a chat prompt)
  // or intercepted by the slash dispatcher (a command).
  agent.run = runSpy as unknown as Agent['run'];
  setYolo = vi.fn();
  applyProvider = vi.fn(async () => {});
  vi.mocked(listModels).mockClear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('UI slash commands (terminal integration)', () => {
  it('control: a normal message is routed to the agent', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, 'find idors on the api');
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toBe('find idors on the api');
  });

  it('shows a resumed-session recap when provided', async () => {
    mounted = renderApp({
      resumeSummary: 'Resumed session abc123\n\nPrevious session recap:\n\nDone work',
    });
    await tick();
    expect(mounted.lastFrame()).toContain('Resumed session abc123');
    expect(mounted.lastFrame()).toContain('Done work');
  });

  it('collapses multi-line pasted text in the UI but sends the full text', async () => {
    mounted = renderApp();
    await tick();

    mounted.stdin.write('line one\nline two\nline three');
    await tick();

    expect(mounted.lastFrame()).toContain('[Pasted text #1 +3 lines, 28 chars]');
    expect(mounted.lastFrame()).not.toContain('line two');

    mounted.stdin.write('\r');
    await tick();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toBe('line one\nline two\nline three');
    expect(mounted.stdout.frames.join('')).toContain('[Pasted text #1 +3 lines, 28 chars]');
  });

  it('/exit is handled as a command, not sent to the agent', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/exit');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/quit is handled as a command, not sent to the agent', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/quit');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/yolo on then off flips the gate and the status-bar pill', async () => {
    mounted = renderApp();
    await tick();

    await submit(mounted.stdin, '/yolo on');
    expect(setYolo).toHaveBeenLastCalledWith(true); // the real gate flips
    expect(mounted.lastFrame()).toContain('YOLO on'); // UI confirms

    await submit(mounted.stdin, '/yolo off');
    expect(setYolo).toHaveBeenLastCalledWith(false);
    expect(mounted.lastFrame()).toContain('YOLO off');

    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/provider opens the backend picker', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/provider');
    const frame = mounted.lastFrame() ?? '';
    expect(frame).toMatch(/backend|Ollama/i);
    expect(frame).toContain('Kimi');
    expect(frame).toContain('OpenRouter');
    expect(frame).toContain('DeepSeek');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/provider can collect and test a Kimi API key before model selection', async () => {
    mounted = renderApp({
      readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    });
    await tick();
    await submit(mounted.stdin, '/provider');

    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(mounted.lastFrame()).toContain('Kimi API');
    mounted.stdin.write('sk-kimi-test');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(listModels).toHaveBeenCalledWith('kimi', 'https://api.moonshot.ai/v1', 'sk-kimi-test');
    expect(mounted.lastFrame()).toContain('Select model for Kimi');

    mounted.stdin.write('\r');
    await tick();
    expect(applyProvider).toHaveBeenCalledWith({
      backend: 'kimi',
      model: 'qwen2.5-coder:14b',
      baseURL: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-kimi-test',
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/provider asks for a Kimi key instead of reusing another provider key', async () => {
    mounted = renderApp({
      readConfig: () => ({
        backend: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: 'gsk-existing',
        model: 'openai/gpt-oss-20b',
      }),
    });
    await tick();
    await submit(mounted.stdin, '/provider');

    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(mounted.lastFrame()).toContain('Kimi API');
    mounted.stdin.write('sk-kimi-fresh');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(listModels).toHaveBeenCalledWith('kimi', 'https://api.moonshot.ai/v1', 'sk-kimi-fresh');
  });

  it('/provider can collect and test a Groq API key before model selection', async () => {
    mounted = renderApp({
      readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    });
    await tick();
    await submit(mounted.stdin, '/provider');

    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(mounted.lastFrame()).toContain('Groq API');
    mounted.stdin.write('gsk-groq-test');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(listModels).toHaveBeenCalledWith(
      'groq',
      'https://api.groq.com/openai/v1',
      'gsk-groq-test',
    );
    expect(mounted.lastFrame()).toContain('Select model for Groq');

    mounted.stdin.write('\r');
    await tick();
    expect(applyProvider).toHaveBeenCalledWith({
      backend: 'groq',
      model: 'qwen2.5-coder:14b',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk-groq-test',
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/provider can collect a Gemini API key and tags cheap models', async () => {
    vi.mocked(listModels).mockResolvedValueOnce([
      'models/gemini-3.5-flash',
      'models/gemini-flash-lite-latest',
    ]);
    mounted = renderApp({
      readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    });
    await tick();
    await submit(mounted.stdin, '/provider');

    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(mounted.lastFrame()).toContain('Gemini API');
    mounted.stdin.write('gemini-test');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(listModels).toHaveBeenCalledWith(
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta',
      'gemini-test',
    );
    expect(mounted.lastFrame()).toContain('Select model for Gemini');
    expect(mounted.lastFrame()).toContain('cheap cost');

    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();
    expect(applyProvider).toHaveBeenCalledWith({
      backend: 'gemini',
      model: 'models/gemini-flash-lite-latest',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'gemini-test',
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/provider can collect and test an OpenRouter API key before model selection', async () => {
    vi.mocked(listModels).mockResolvedValueOnce(['openrouter/auto', 'anthropic/claude-sonnet-4.5']);
    mounted = renderApp({
      readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    });
    await tick();
    await submit(mounted.stdin, '/provider');

    // Ollama→LM Studio→Kimi→Groq→Gemini→Claude→OpenRouter: 6 down-presses.
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(mounted.lastFrame()).toContain('OpenRouter');
    mounted.stdin.write('sk-or-test');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(listModels).toHaveBeenCalledWith(
      'openrouter',
      'https://openrouter.ai/api/v1',
      'sk-or-test',
    );
    expect(mounted.lastFrame()).toContain('Select model for OpenRouter');
    expect(mounted.lastFrame()).toContain('OpenRouter router');

    mounted.stdin.write('\r');
    await tick();
    expect(applyProvider).toHaveBeenCalledWith({
      backend: 'openrouter',
      model: 'openrouter/auto',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/provider can collect and test a DeepSeek API key before model selection', async () => {
    vi.mocked(listModels).mockResolvedValueOnce(['deepseek-v4-flash', 'deepseek-v4-pro']);
    mounted = renderApp({
      readConfig: () => ({ backend: 'ollama', baseURL: '', apiKey: '', model: 'stub-model' }),
    });
    await tick();
    await submit(mounted.stdin, '/provider');

    // Ollama→LM Studio→Kimi→Groq→Gemini→Claude→OpenRouter→DeepSeek: 7 down-presses.
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(mounted.lastFrame()).toContain('DeepSeek');
    mounted.stdin.write('sk-deepseek-test');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(listModels).toHaveBeenCalledWith(
      'deepseek',
      'https://api.deepseek.com',
      'sk-deepseek-test',
    );
    expect(mounted.lastFrame()).toContain('Select model for DeepSeek');

    mounted.stdin.write('\r');
    await tick();
    expect(applyProvider).toHaveBeenCalledWith({
      backend: 'deepseek',
      model: 'deepseek-v4-flash',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-test',
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/model list opens an interactive picker and switches on Enter', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/model list');
    await tick();

    expect(listModels).toHaveBeenCalledWith('ollama', '', '');
    const frame = mounted.lastFrame() ?? '';
    expect(frame).toContain('Select model for ollama');
    expect(frame).toContain('stub-model');
    expect(frame).toContain('qwen2.5-coder:14b');
    expect(frame).toContain('current / used before');

    mounted.stdin.write('\x1B[B');
    await tick();
    mounted.stdin.write('\r');
    await tick();

    expect(applyProvider).toHaveBeenCalledWith({
      backend: 'ollama',
      model: 'qwen2.5-coder:14b',
      baseURL: '',
      apiKey: '',
    });
    expect(mounted.lastFrame()).toContain('model set to qwen2.5-coder:14b');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('keeps up/down navigation inside multi-line input instead of history', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/help');
    expect(runSpy).not.toHaveBeenCalled();

    mounted.stdin.write('alpha');
    await tick();
    mounted.stdin.write('\x0e'); // Ctrl-N inserts a newline in the prompt editor.
    await tick();
    mounted.stdin.write('beta');
    await tick();
    mounted.stdin.write('\x1B[A');
    await tick();
    mounted.stdin.write('\x1B[A');
    await tick();
    mounted.stdin.write('X');
    await tick();

    const frame = mounted.lastFrame() ?? '';
    expect(frame).toContain('Xalpha');
    expect(frame).toContain('beta');
    expect(frame).not.toContain('/helpX');
  });

  it('/plan runs a plan-only turn with tools disabled', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/plan test gobus.net');
    await tick();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain('Plan this objective');
    expect(runSpy.mock.calls[0][0]).toContain('plan-only mode');
    expect(runSpy.mock.calls[0][0]).toContain('ask concise clarifying questions');
    expect(runSpy.mock.calls[0][0]).toContain('decision-complete implementation plan');
    expect(runSpy.mock.calls[0][0]).toContain('test gobus.net');
    expect(runSpy.mock.calls[0][0]).toContain('<proposed_plan>');
    expect(runSpy.mock.calls[0][3]).toEqual({ tools: false });
    expect(mounted.lastFrame()).toContain('/plan test gobus.net');
    expect(mounted.lastFrame()).toContain('planning only');
  });

  it('/plan without args plans from current context', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/plan');
    await tick();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain('current objective');
    expect(runSpy.mock.calls[0][3]).toEqual({ tools: false });
  });

  it('/next builds a coverage-driven plan-only turn', async () => {
    const coverageSpy = vi
      .spyOn(agent, 'coverageContext')
      .mockResolvedValue('Coverage summary:\n{"total":1}\n\nCoverage entries:\nno entries match.');
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/next authz sweep');
    await tick();

    expect(coverageSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toContain('coverage-driven planning mode');
    expect(runSpy.mock.calls[0][0]).toContain('Coverage summary');
    expect(runSpy.mock.calls[0][0]).toContain('authz sweep');
    expect(runSpy.mock.calls[0][3]).toEqual({ tools: false });
    expect(mounted.lastFrame()).toContain('/next authz sweep');
  });

  it('/snapshot writes context without sending a chat turn', async () => {
    const snapshotSpy = vi.spyOn(agent, 'saveContextSnapshot').mockResolvedValue('/tmp/context.md');
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/snapshot');
    await tick();

    expect(snapshotSpy).toHaveBeenCalledWith('manual /snapshot');
    expect(mounted.lastFrame()).toContain('context snapshot saved');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/burp starts the local listener from the menu', async () => {
    const startBurpBridge = vi.fn(async (port?: number) => ({
      url: `http://127.0.0.1:${port ?? 9999}`,
      alreadyRunning: false,
    }));
    mounted = renderApp({ startBurpBridge });
    await tick();
    await submit(mounted.stdin, '/burp 7777');
    await tick();

    expect(startBurpBridge).toHaveBeenCalledWith(7777);
    expect(mounted.lastFrame()).toContain('Burp bridge listening at http://127.0.0.1:7777');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/burp reports an existing listener', async () => {
    const startBurpBridge = vi.fn(async () => ({
      url: 'http://127.0.0.1:9999',
      alreadyRunning: true,
    }));
    mounted = renderApp({ startBurpBridge });
    await tick();
    await submit(mounted.stdin, '/burp');
    await tick();

    expect(startBurpBridge).toHaveBeenCalledWith(undefined);
    expect(mounted.lastFrame()).toContain('Burp bridge already listening at http://127.0.0.1:9999');
  });

  it('/burp rejects invalid ports', async () => {
    const startBurpBridge = vi.fn();
    mounted = renderApp({ startBurpBridge });
    await tick();
    await submit(mounted.stdin, '/burp nope');
    await tick();

    expect(startBurpBridge).not.toHaveBeenCalled();
    expect(mounted.lastFrame()).toContain('usage: /burp [port]');
  });

  it('/clear emits the clear-screen escape and is not sent to the agent', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/clear');
    // clearScreen() writes \x1b[2J\x1b[3J\x1b[H to stdout.
    const allOutput = mounted.stdout.frames.join('');
    expect(allOutput).toContain('\x1b[2J');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('/update runs the GitHub updater and is not sent to the agent', async () => {
    mounted = renderApp();
    await tick();
    await submit(mounted.stdin, '/update v0.1.0');
    await tick();
    expect(runSelfUpdate).toHaveBeenCalledWith('v0.1.0');
    expect(mounted.lastFrame()).toContain('update installed');
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('EntryView streaming vs committed rendering', () => {
  // A streaming assistant entry renders in App's live frame on every token.
  // The markdown/highlight pipeline must NOT run there (it re-runs over the
  // whole accumulated answer per token); it runs once when the entry is
  // finalized and committed to <Static>.
  const entry: TranscriptEntry = {
    kind: 'assistant',
    text: 'Here is **bold** and `code`',
    streaming: true,
  };

  it('renders the live (streaming) entry as plain text — no markdown pipeline', () => {
    const { lastFrame } = render(<EntryView entry={entry} streaming />);
    const frame = lastFrame() ?? '';
    // Raw markdown markers survive verbatim because renderMarkdown is skipped.
    expect(frame).toContain('**bold**');
    expect(frame).toContain('`code`');
  });

  it('renders the committed (finalized) entry through the markdown pipeline', () => {
    const { lastFrame } = render(<EntryView entry={{ ...entry, streaming: false }} />);
    const frame = lastFrame() ?? '';
    // renderMarkdown strips the ** / ` markers, styling the inner text instead.
    expect(frame).toContain('bold');
    expect(frame).not.toContain('**bold**');
    expect(frame).not.toContain('`code`');
  });
});
