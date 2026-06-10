// Tool interface. — every tool
// the model can call implements this. Schema is the JSON Schema sent to
// the model as the `parameters` field of the function definition.

import type { Prompter } from '../permission/permission.js';

export interface Tool {
  name(): string;
  description(): string;
  schema(): Record<string, unknown>;
  requiresPermission(): boolean;
  run(args: Record<string, unknown>, signal: AbortSignal, prompter: Prompter): Promise<string>;
  /** Optional short label + full detail for the permission modal / logs. */
  summarize?(args: Record<string, unknown>): { summary: string; detail: string };
  /** Optional risk hints applied to the permission request the registry
   *  builds for this tool (e.g. shell opts out of session caching). */
  permissionHints?(args: Record<string, unknown>): {
    noSessionCache?: boolean;
    cacheKey?: string;
  };
}

/** Read a string arg defensively (returns '' on missing / wrong type). */
export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** Read a boolean arg defensively (returns false on missing / wrong type). */
export function argBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return typeof v === 'boolean' ? v : false;
}

/** Read a numeric arg defensively (returns undefined on missing / wrong type). */
export function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
