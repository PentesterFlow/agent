import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PermissionModal, isCommandTool } from './PermissionModal.js';
import type { PermissionRequest } from './permBridge.js';

function req(overrides: Partial<PermissionRequest>): PermissionRequest {
  return {
    tool: 'shell',
    summary: 'shell: curl …',
    detail: '',
    resolve: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  };
}

describe('isCommandTool', () => {
  it('flags command/payload tools and ignores others', () => {
    for (const t of ['shell', 'bash', 'BashTool', 'http', 'file_write', 'file_edit']) {
      expect(isCommandTool(t)).toBe(true);
    }
    for (const t of ['web_fetch', 'ask_user', 'coverage', 'confirm_finding']) {
      expect(isCommandTool(t)).toBe(false);
    }
  });
});

describe('PermissionModal', () => {
  it('shows a long command in full where the old prose cap would have cut it', () => {
    // ~2700 chars: beyond the 1200 prose cap, within the 8000 command cap.
    const longCmd = `curl -s -X POST 'https://target.test/api/login' ${'-H x:y '.repeat(380)}END`;
    expect(longCmd.length).toBeGreaterThan(1200);
    const { lastFrame } = render(<PermissionModal req={req({ tool: 'shell', detail: longCmd })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('curl -s -X POST');
    // The tail survives and there is no truncation marker — proves the
    // command cap, not the prose cap, is in effect.
    expect(frame).toContain('END');
    expect(frame).not.toContain('truncated');
  });

  it('caps a pathologically long command but keeps the head', () => {
    const huge = `echo ${'A'.repeat(9000)}`;
    const { lastFrame } = render(<PermissionModal req={req({ tool: 'shell', detail: huge })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('echo AAAA');
    expect(frame).toContain('truncated');
  });
});
