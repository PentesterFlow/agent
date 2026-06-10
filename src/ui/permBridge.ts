// Bridges the agent's Prompter interface (called from a non-React
// goroutine-equivalent) to React state managed by the TUI. A pending
// request lives in app state until the user picks y/a/n; the agent's
// promise resolves when that happens.

import type { Decision, Prompter, Request } from '../permission/permission.js';

export interface PermissionRequest extends Request {
  resolve: (d: Decision) => void;
  reject: (err: Error) => void;
}

export type PermissionPublisher = (req: PermissionRequest | null) => void;

export class BridgedPrompter implements Prompter {
  private publish: PermissionPublisher;
  private sessionAllowed = new Set<string>();

  constructor(publish: PermissionPublisher) {
    this.publish = publish;
  }

  // Session-cache identity. Keying on the tool name alone would let one
  // "allow session" on a benign invocation (e.g. `id`) whitelist every later
  // call of that tool — including arbitrary commands / hosts / paths. Keying
  // on (tool, cacheKey) scopes the approval to the specific command, origin,
  // or path the user actually saw. Tools without a cacheKey keep whole-tool
  // caching (fine for low-consequence tools). Tool names never contain
  // spaces, so "<tool> <cacheKey>" can't collide across tools.
  private keyFor(req: Request): string {
    return req.cacheKey ? `${req.tool} ${req.cacheKey}` : req.tool;
  }

  async ask(req: Request, signal?: AbortSignal): Promise<Decision> {
    // Consult noSessionCache BEFORE the cache read: a request that opts out of
    // session caching must always re-prompt, never be silently satisfied from
    // the cache (L13 — defuses a latent bypass even though key spaces don't
    // currently collide).
    if (!req.noSessionCache && this.sessionAllowed.has(this.keyFor(req))) return 'allow-once';
    return new Promise<Decision>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const onAbort = () => {
        this.publish(null);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const wrapped: PermissionRequest = {
        ...req,
        resolve: (d: Decision) => {
          signal?.removeEventListener('abort', onAbort);
          // Sensitive requests can opt out of session caching: honor this
          // one approval but re-prompt next time.
          if (d === 'allow-session' && !req.noSessionCache)
            this.sessionAllowed.add(this.keyFor(req));
          this.publish(null);
          resolve(d);
        },
        reject: (err: Error) => {
          signal?.removeEventListener('abort', onAbort);
          this.publish(null);
          reject(err);
        },
      };
      this.publish(wrapped);
    });
  }
}
