// Slash-command catalog. Single source of truth for the menu, the
// completion logic, and the dispatcher in App.tsx.

export interface SlashItem {
  name: string; // includes leading slash, e.g. "/help"
  args?: string; // arg hint shown next to the name
  description: string;
}

export const SLASH_ITEMS: SlashItem[] = [
  { name: '/help', description: 'show keybindings + slash commands' },
  {
    name: '/provider',
    description: 'interactive picker: select LLM backend, then a model from its catalog',
  },
  { name: '/model', args: '<id|list>', description: 'switch model or list backend models' },
  { name: '/plan', args: '[objective]', description: 'plan-only mode without tools' },
  { name: '/next', args: '[objective]', description: 'coverage-driven next test suggestions' },
  { name: '/compact', description: 'summarize conversation into persistent session memory' },
  {
    name: '/memory',
    args: '[clear|forget <text>]',
    description: 'show session memory; clear wipes it, forget drops matching items',
  },
  { name: '/snapshot', description: 'write the current redacted context snapshot now' },
  { name: '/burp', args: '[port]', description: 'start the local Burp/PentesterFlow listener' },
  { name: '/clear', description: 'clear the on-screen transcript only' },
  { name: '/reset', description: 'clear conversation + saved session' },
  {
    name: '/target',
    args: '<url>',
    description: 'pin an engagement base URL; http tool defaults to it (no arg clears)',
  },
  {
    name: '/skills',
    args: '[enable|disable|new <name>]',
    description: 'list/toggle skills, or scaffold a new one (/skills new <name>)',
  },
  { name: '/maxsteps', args: '<n>', description: 'per-turn tool-call cap (default 20)' },
  { name: '/thinking', args: 'on|off', description: 'toggle the show-thinking system directive' },
  { name: '/update', args: '[version]', description: 'fetch GitHub release updates and install' },
  { name: '/yolo', args: '[on|off]', description: 'toggle auto-approve for every tool call' },
  { name: '/exit', description: 'quit pentesterflow' },
];

/**
 * Filter a catalog by what the user has typed so far. Empty input
 * returns the full list; `/he` returns `/help`; partial commands match
 * by prefix on the command name (case-insensitive). `extras` is appended
 * to SLASH_ITEMS so callers can splice in dynamic items (e.g. one
 * `/<skill-name>` entry per loaded skill) without mutating the static
 * catalog.
 */
export function filterSlash(input: string, extras: SlashItem[] = []): SlashItem[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return [];
  // If the user already finished a slash command and is typing args
  // (whitespace after the command), suppress the menu.
  if (/\s/.test(trimmed.slice(1))) return [];
  const all = extras.length > 0 ? [...SLASH_ITEMS, ...extras] : SLASH_ITEMS;
  const needle = trimmed.toLowerCase();
  if (needle === '/') return all;
  return all.filter((s) => s.name.toLowerCase().startsWith(needle));
}
