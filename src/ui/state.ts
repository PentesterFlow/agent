// App-wide TUI state. Kept as a useReducer-friendly shape so each
// component subscribes to only the slice it needs. The agent loop runs
// outside React and pushes events via dispatch().

import type { AgentEvent } from '../agent/events.js';
import { displayToolName, formatToolResult, primaryToolArg } from '../tools/toolDisplay.js';
import type { BannerData } from './Banner.js';
import type { AskRequest } from './askBridge.js';
import type { PermissionRequest } from './permBridge.js';
import { buildToolResultView, shellResultExitStatus } from './toolResultFormat.js';

export interface TranscriptEntry {
  kind:
    | 'user'
    | 'assistant'
    | 'tool-call'
    | 'tool-result'
    | 'system'
    | 'error'
    | 'finding'
    | 'decision';
  text: string;
  /** Set on streaming assistant text so deltas can append in place. While
   *  true and at the tail, this entry renders in the live frame rather
   *  than the committed scrollback log. */
  streaming?: boolean;
  /** Tool-results whose body was truncated keep the full text so Ctrl-O
   *  can reprint it as a NEW log entry — committed scrollback output can't
   *  be toggled in place. `text` always holds the short preview. */
  collapsible?: boolean;
  fullText?: string;
  /** Set once the full body has been reprinted so Ctrl-O won't duplicate it. */
  expanded?: boolean;
  /** Optional display prefix override for entries with custom transcript chrome. */
  prefix?: string;
  /** Optional display color override for entries that need semantic emphasis. */
  color?: string;
}

export type UiPhase =
  | 'idle'
  | 'planning'
  | 'running-tool'
  | 'answering'
  | 'waiting-approval'
  | 'waiting-user'
  | 'skills';

export type TranscriptFilter = 'all' | 'compact' | 'findings' | 'errors' | 'current';

export interface AppState {
  banner: string;
  bannerData: BannerData;
  transcript: TranscriptEntry[];
  busy: boolean;
  /** Bumped by `clear` so the Static scrollback log remounts and stops
   *  reprinting the old (now-cleared) items. */
  clearGen: number;
  apiReady: boolean;
  activeSkill: string | null;
  pendingPerm: PermissionRequest | null;
  pendingAsk: AskRequest | null;
  /** When true, the interactive /skills picker is mounted. The picker
   *  reads live registry state on every render, so we don't keep any
   *  snapshot in this slot — a boolean is enough. */
  pendingSkills: boolean;
  yolo: boolean;
  phase: UiPhase;
  transcriptFilter: TranscriptFilter;
  /** Display name of the tool currently executing, shown in the busy status
   *  line while phase === 'running-tool'. Set on tool-call, cleared on done. */
  runningTool: string | null;
}

export function initialState(banner: string, bannerData: BannerData): AppState {
  return {
    banner,
    bannerData,
    transcript: [],
    busy: false,
    clearGen: 0,
    apiReady: true,
    activeSkill: null,
    pendingPerm: null,
    pendingAsk: null,
    pendingSkills: false,
    yolo: false,
    phase: 'idle',
    transcriptFilter: 'all',
    runningTool: null,
  };
}

export type Action =
  | { type: 'set-banner'; banner: string }
  | { type: 'merge-banner-data'; patch: Partial<BannerData> }
  | { type: 'append'; entry: TranscriptEntry }
  | { type: 'append-delta'; text: string }
  | { type: 'set-busy'; busy: boolean }
  | { type: 'set-api-ready'; ready: boolean }
  | { type: 'set-active-skill'; name: string | null }
  | { type: 'set-yolo'; on: boolean }
  | { type: 'set-perm'; req: PermissionRequest | null }
  | { type: 'set-ask'; req: AskRequest | null }
  | { type: 'set-skills-picker'; open: boolean }
  | { type: 'cycle-transcript-filter' }
  | { type: 'expand-tool-output' }
  | { type: 'clear' }
  | { type: 'agent-event'; event: AgentEvent };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'set-banner':
      return { ...state, banner: action.banner };
    case 'merge-banner-data':
      return { ...state, bannerData: { ...state.bannerData, ...action.patch } };
    case 'append':
      return { ...state, transcript: [...state.transcript, action.entry] };
    case 'append-delta': {
      // A streamed delta means the model is producing output — leave the
      // 'planning' phase so the status line stops claiming we're still
      // thinking. Without this, a long streamed answer shows "planning" for
      // its entire duration and looks hung.
      const phase: UiPhase = state.busy ? 'answering' : state.phase;
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const updated = { ...last, text: last.text + action.text };
        return {
          ...state,
          phase,
          transcript: [...state.transcript.slice(0, -1), updated],
        };
      }
      return {
        ...state,
        phase,
        transcript: [
          ...state.transcript,
          { kind: 'assistant', text: action.text, streaming: true },
        ],
      };
    }
    case 'set-busy':
      return { ...state, busy: action.busy, phase: action.busy ? 'planning' : 'idle' };
    case 'set-api-ready':
      return { ...state, apiReady: action.ready };
    case 'set-active-skill':
      return { ...state, activeSkill: action.name };
    case 'set-yolo':
      return { ...state, yolo: action.on };
    case 'set-perm':
      return {
        ...state,
        pendingPerm: action.req,
        phase: action.req ? 'waiting-approval' : state.busy ? 'running-tool' : 'idle',
      };
    case 'set-ask':
      return {
        ...state,
        pendingAsk: action.req,
        phase: action.req ? 'waiting-user' : state.busy ? 'answering' : 'idle',
      };
    case 'set-skills-picker':
      return { ...state, pendingSkills: action.open, phase: action.open ? 'skills' : 'idle' };
    case 'cycle-transcript-filter':
      return { ...state, transcriptFilter: nextTranscriptFilter(state.transcriptFilter) };
    case 'expand-tool-output': {
      // Reprint the most recent not-yet-expanded collapsible tool-result's
      // full body as a NEW log entry. Committed scrollback can't be toggled
      // in place, so "expand" means append. Mark the source `expanded` so a
      // second Ctrl-O doesn't duplicate it; walk from the tail so Ctrl-O
      // acts on "the thing I just ran".
      let idx = -1;
      for (let i = state.transcript.length - 1; i >= 0; i -= 1) {
        const e = state.transcript[i];
        if (e?.collapsible && !e.expanded) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return state;
      const entry = state.transcript[idx];
      if (!entry) return state;
      const transcript = [...state.transcript];
      transcript[idx] = { ...entry, expanded: true };
      transcript.push({ kind: 'tool-result', text: entry.fullText ?? entry.text });
      return { ...state, transcript };
    }
    case 'clear':
      // Reset the log and bump clearGen so the Static viewport remounts and
      // stops reprinting the cleared items. Prior output stays in the
      // terminal's native scrollback, like a real shell.
      return { ...state, transcript: [], clearGen: state.clearGen + 1 };
    case 'agent-event':
      return applyAgentEvent(state, action.event);
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

const TRANSCRIPT_FILTERS: TranscriptFilter[] = ['all', 'compact', 'findings', 'errors', 'current'];

function nextTranscriptFilter(current: TranscriptFilter): TranscriptFilter {
  const idx = TRANSCRIPT_FILTERS.indexOf(current);
  return TRANSCRIPT_FILTERS[(idx + 1) % TRANSCRIPT_FILTERS.length] ?? 'all';
}

const TOOL_CALL_PREVIEW_CAP = 120;
const SHELL_TITLE_CAP = 72;
const SHELL_BLOCK_COMMAND_THRESHOLD = 88;

/**
 * Collapse a tool-call's raw JSON args into a single-line preview for
 * the transcript: convert escaped \n / \t (from the LLM's JSON
 * encoding) and any raw control chars to single spaces, collapse runs,
 * truncate to TOOL_CALL_PREVIEW_CAP. Full args still go to the log.
 *
 * Without this, multi-line heredocs (`{"command":"python3 -c \"\nports = [\n  80,..."}`)
 * spill across the transcript with awkward terminal wrapping.
 */
function previewArgs(raw: string): string {
  const oneLine = raw
    .replace(/\\[nrt]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (oneLine.length <= TOOL_CALL_PREVIEW_CAP) return oneLine;
  return `${oneLine.slice(0, TOOL_CALL_PREVIEW_CAP)}…`;
}

// Renders tool-call args for display. Some tools have a single, obvious
// argument worth showing bare instead of as raw JSON — e.g. the browser
// tool's `url`. Falls back to the one-line JSON preview otherwise.
function previewToolArgs(name: string, raw: string): string {
  try {
    const primary = primaryToolArg(name, JSON.parse(raw) as Record<string, unknown>);
    if (primary !== null) return previewArgs(primary);
  } catch {
    // Malformed/partial JSON — fall through to the raw preview.
  }
  return previewArgs(raw);
}

function isShellTool(name: string): boolean {
  return name === 'shell' || name === 'bash' || name === 'BashTool';
}

function toolCallColor(name: string): string | undefined {
  return name === 'confirm_finding' ? 'red' : undefined;
}

/** Ink text color for a finding severity. The severity is also spelled out in
 *  the card text, so color is reinforcement, not the sole signal (keeps it
 *  legible for color-blind users / NO_COLOR). */
function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'magenta';
    case 'high':
      return 'red';
    case 'medium':
      return 'yellow';
    case 'low':
      return 'cyan';
    case 'info':
      return 'gray';
    default:
      return 'yellow';
  }
}

/**
 * Build a severity-colored finding card from a confirm_finding tool call's
 * args. Returns null when the args don't parse or lack a title, so the caller
 * can fall back to the normal tool-call rendering.
 */
function formatFindingCard(argsJSON: string): { text: string; color: string } | null {
  let a: Record<string, unknown>;
  try {
    a = JSON.parse(argsJSON) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const title = str('title');
  if (!title) return null;
  const severity = str('severity').toLowerCase();
  const method = str('method');
  const url = str('url');
  const parameter = str('parameter');
  const impact = str('impact');

  const lines = [`${severity ? severity.toUpperCase() : 'FINDING'} · ${title}`];
  if (url) {
    const loc = `${method ? `${method} ` : ''}${url}${parameter ? `  (param: ${parameter})` : ''}`;
    lines.push(`  ${loc}`);
  }
  if (impact) lines.push(`  impact: ${impact}`);
  return { text: lines.join('\n'), color: severityColor(severity) };
}

function shellDisplayName(name: string): string {
  return name === 'shell' ? 'Shell' : 'Bash';
}

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function shellCommandFromArgs(argsJSON: string): string | null {
  try {
    const parsed = JSON.parse(argsJSON) as Record<string, unknown>;
    return typeof parsed.command === 'string' && parsed.command ? parsed.command : null;
  } catch {
    return null;
  }
}

function cleanShellComment(line: string): string {
  return line
    .replace(/^#\s*/, '')
    .replace(/\s+-\s+.+$/, '')
    .trim();
}

function isShellAssignment(line: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(line);
}

function shellActionFromCommand(command: string): { title: string; command: string } | null {
  const lines = command
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const commentIdx = lines.findIndex((line) => line.startsWith('#'));
  if (commentIdx === -1) return null;
  if (commentIdx > 0 && lines.slice(0, commentIdx).some((line) => !isShellAssignment(line))) {
    return null;
  }

  const comment = lines[commentIdx] ?? '';
  const runnable = lines.filter((line) => !line.startsWith('#'));

  if (lines.length > 1) {
    return {
      title: capText(cleanShellComment(comment), SHELL_TITLE_CAP),
      command: previewArgs(runnable.join(' && ')),
    };
  }

  const curlIdx = comment.indexOf(' curl ');
  if (curlIdx !== -1) {
    return {
      title: capText(cleanShellComment(comment.slice(0, curlIdx)), SHELL_TITLE_CAP),
      command: previewArgs(comment.slice(curlIdx + 1)),
    };
  }

  return {
    title: capText(cleanShellComment(comment), SHELL_TITLE_CAP),
    command: previewArgs(command),
  };
}

function shellLongCommandBlock(command: string): { title: string; command: string } | null {
  const preview = previewArgs(command);
  const isStructured =
    command.includes('\n') ||
    command.includes(' && ') ||
    command.includes(' || ') ||
    command.includes(';');
  if (preview.length < SHELL_BLOCK_COMMAND_THRESHOLD && !preview.endsWith('…') && !isStructured) {
    return null;
  }

  return { title: shellTitleFromPreview(preview), command: preview };
}

function shellTitleFromPreview(preview: string): string {
  const firstWord = firstShellWord(preview);
  switch (firstWord) {
    case 'curl':
    case 'http':
    case 'wget':
      return 'HTTP request';
    case 'for':
    case 'while':
    case 'until':
      return 'Run loop';
    case 'mkdir':
      return 'Create directory';
    case 'grep':
    case 'rg':
      return 'Search files';
    case 'find':
      return 'Find files';
    case 'cat':
    case 'head':
    case 'tail':
      return 'Read output';
    case 'awk':
    case 'jq':
    case 'sed':
      return 'Process text';
    case 'python':
    case 'python3':
    case 'node':
    case 'tsx':
      return 'Run script';
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return 'Run package task';
    case 'git':
      return 'Git command';
    case 'openssl':
      return 'OpenSSL';
    case 'echo':
    case 'printf':
      return 'Print text';
    default:
      return `Run ${firstWord}`;
  }
}

function firstShellWord(preview: string): string {
  const withoutAssignments = preview.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/,
    '',
  );
  return withoutAssignments.match(/^[A-Za-z0-9_.:/-]+/)?.[0] ?? 'command';
}

function formatToolCallText(name: string, argsJSON: string): string {
  const argsPreview = previewToolArgs(name, argsJSON);
  if (isShellTool(name)) {
    const shellName = shellDisplayName(name);
    const command = shellCommandFromArgs(argsJSON);
    const action = command
      ? (shellActionFromCommand(command) ?? shellLongCommandBlock(command))
      : null;
    if (action) return `${shellName} · ${action.title}\n$ ${action.command}`;
    return `${shellName}(${argsPreview})`;
  }
  if (name === 'ask_user') return `${displayToolName(name)} · ${argsPreview}`;
  return `${displayToolName(name)} ${argsPreview}`;
}

/** Short label for the busy status line — the human action, not the raw
 *  command. Shell calls show their inferred title ("HTTP request", "Search
 *  files"); everything else shows the friendly tool name. */
function runningToolLabel(name: string, argsJSON: string): string {
  if (isShellTool(name)) {
    const command = shellCommandFromArgs(argsJSON);
    const action = command
      ? (shellActionFromCommand(command) ?? shellLongCommandBlock(command))
      : null;
    if (action?.title) return `${shellDisplayName(name)} · ${action.title}`;
    return shellDisplayName(name);
  }
  return displayToolName(name);
}

function isSuccessfulEmptyShellResult(result: string): boolean {
  const plain = result.replace(/\r\n/g, '\n').trimEnd();
  return plain === 'exit: 0\nstdout:';
}

function isEmptyShellExit(result: string, exit: string): boolean {
  const plain = result.replace(/\r\n/g, '\n').trimEnd();
  return plain === `exit: ${exit}\nstdout:`;
}

function previousShellCallWasSearch(transcript: TranscriptEntry[]): boolean {
  const prev = transcript.at(-1);
  if (!prev || prev.kind !== 'tool-call') return false;
  return /(^|\s|\||\$ )(grep|rg)(\s|$)/.test(prev.text);
}

function toolResultPrefix(
  name: string,
  err: string,
  result: string,
  durationMs: number,
  transcript: TranscriptEntry[],
): string {
  if (err) return `[error] ${displayToolName(name)}: ${err}`;
  if (isShellTool(name)) {
    const exit = shellResultExitStatus(result);
    if (exit && exit !== '0') {
      if (
        exit === '1' &&
        isEmptyShellExit(result, exit) &&
        previousShellCallWasSearch(transcript)
      ) {
        return `[no match] ${displayToolName(name)} (${durationMs}ms)`;
      }
      const label = exit.startsWith('timeout') ? 'timeout' : `exit ${exit}`;
      return `[${label}] ${displayToolName(name)} (${durationMs}ms)`;
    }
  }
  return `[ok] ${displayToolName(name)} (${durationMs}ms)`;
}

function formatCompactEvent(ev: Extract<AgentEvent, { type: 'compact' }>): string {
  const meta: string[] = [];
  if (typeof ev.tokensBefore === 'number' && typeof ev.tokensAfter === 'number') {
    meta.push(`~${ev.tokensBefore} → ~${ev.tokensAfter} tokens`);
  }
  if (typeof ev.memoryItems === 'number') meta.push(`${ev.memoryItems} memory items`);
  return meta.length > 0
    ? `compacted: ${ev.summary}\n${meta.join(' · ')}`
    : `compacted: ${ev.summary}`;
}

function applyAgentEvent(state: AppState, ev: AgentEvent): AppState {
  switch (ev.type) {
    case 'assistant-text': {
      // Finalize any active stream entry, or append a fresh one.
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const finalized: TranscriptEntry = { ...last, streaming: false };
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript.slice(0, -1), finalized],
        };
      }
      return {
        ...state,
        phase: 'answering',
        transcript: [...state.transcript, { kind: 'assistant', text: ev.text }],
      };
    }
    case 'assistant-delta':
      return reducer(state, { type: 'append-delta', text: ev.text });
    case 'tool-call': {
      // confirm_finding gets a first-class, severity-colored finding card
      // instead of a generic tool-call line — the headline output of an
      // engagement should stand out, not read like any other tool call.
      if (ev.name === 'confirm_finding') {
        const card = formatFindingCard(ev.argsJSON);
        if (card) {
          return {
            ...state,
            transcript: [
              ...state.transcript,
              { kind: 'finding', text: card.text, color: card.color, prefix: '★ ' },
            ],
            phase: 'running-tool',
            runningTool: runningToolLabel(ev.name, ev.argsJSON),
          };
        }
      }
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: 'tool-call',
            text: formatToolCallText(ev.name, ev.argsJSON),
            prefix: isShellTool(ev.name) ? '⏺ ' : undefined,
            color: toolCallColor(ev.name),
          },
        ],
        phase: 'running-tool',
        runningTool: runningToolLabel(ev.name, ev.argsJSON),
      };
    }
    case 'tool-result': {
      // The finding card (rendered at tool-call) is the headline; the result
      // just confirms where it was saved. Show that as a quiet note, not a
      // generic "[ok] confirm_finding" line.
      if (!ev.err && ev.name === 'confirm_finding') {
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript, { kind: 'tool-result', text: ev.result }],
        };
      }

      if (!ev.err && isShellTool(ev.name) && isSuccessfulEmptyShellResult(ev.result)) {
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript, { kind: 'tool-result', text: 'Done', prefix: '  ⎿ ' }],
        };
      }

      const prefix = toolResultPrefix(ev.name, ev.err, ev.result, ev.durationMs, state.transcript);
      if (
        !ev.err &&
        isShellTool(ev.name) &&
        shellResultExitStatus(ev.result) === '1' &&
        isEmptyShellExit(ev.result, '1') &&
        previousShellCallWasSearch(state.transcript)
      ) {
        return {
          ...state,
          phase: 'answering',
          transcript: [
            ...state.transcript,
            { kind: 'tool-result', text: `${prefix}\n(no matches)` },
          ],
        };
      }
      // Some tools have a compact one-line display form for their JSON
      // result (e.g. browser_capture_status). Use it when present; the
      // model still receives the raw JSON via the tool message.
      if (!ev.err) {
        const friendly = formatToolResult(ev.name, ev.result);
        if (friendly !== null) {
          return {
            ...state,
            phase: 'answering',
            transcript: [
              ...state.transcript,
              { kind: 'tool-result', text: `${prefix}\n${friendly}` },
            ],
          };
        }
      }
      // buildToolResultView pulls readable text out of MCP JSON envelopes,
      // colorizes shell-shaped output, and — for anything long — returns a
      // head-only preview plus the full body. Short results show a single
      // view (not collapsible). Collapsible ones keep `fullText` so Ctrl-O
      // can reprint the full body as a new log entry ('expand-tool-output').
      const view = buildToolResultView(ev.result);
      const collapsedText = `${prefix}\n${view.preview}`;
      if (!view.collapsible) {
        return {
          ...state,
          phase: 'answering',
          transcript: [...state.transcript, { kind: 'tool-result', text: collapsedText }],
        };
      }
      return {
        ...state,
        phase: 'answering',
        transcript: [
          ...state.transcript,
          {
            kind: 'tool-result',
            text: collapsedText,
            collapsible: true,
            fullText: `${prefix}\n${view.full}`,
          },
        ],
      };
    }
    case 'error':
      return {
        ...state,
        phase: state.busy ? 'answering' : state.phase,
        transcript: [...state.transcript, { kind: 'error', text: ev.err.message }],
      };
    case 'compact':
      return {
        ...state,
        phase: 'planning',
        transcript: [...state.transcript, { kind: 'system', text: formatCompactEvent(ev) }],
      };
    case 'decision':
      return {
        ...state,
        phase: 'planning',
        transcript: [...state.transcript, { kind: 'decision', text: ev.summary }],
      };
    case 'skill-active':
      return { ...state, activeSkill: ev.name };
    case 'done': {
      // End of turn: finalize a trailing streaming assistant entry so it
      // moves out of the live frame and into the committed scrollback log.
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === 'assistant' && last.streaming) {
        const finalized: TranscriptEntry = { ...last, streaming: false };
        return {
          ...state,
          busy: false,
          phase: 'idle',
          runningTool: null,
          transcript: [...state.transcript.slice(0, -1), finalized],
        };
      }
      return { ...state, busy: false, phase: 'idle', runningTool: null };
    }
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
      return state;
    }
  }
}
