import { afterEach, describe, expect, it, vi } from 'vitest';
import { chalkLevel, noColorRequested } from './colorLevel.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('colorLevel', () => {
  it('forces truecolor by default', () => {
    vi.stubEnv('NO_COLOR', undefined);
    expect(noColorRequested()).toBe(false);
    expect(chalkLevel()).toBe(3);
  });

  it('drops to level 0 when NO_COLOR is set', () => {
    vi.stubEnv('NO_COLOR', '1');
    expect(noColorRequested()).toBe(true);
    expect(chalkLevel()).toBe(0);
  });

  it('treats an empty NO_COLOR as not-set (per the standard)', () => {
    vi.stubEnv('NO_COLOR', '');
    expect(noColorRequested()).toBe(false);
    expect(chalkLevel()).toBe(3);
  });
});
