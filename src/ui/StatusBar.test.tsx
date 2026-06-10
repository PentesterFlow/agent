import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusProps, formatElapsed } from './StatusBar.js';

function props(overrides: Partial<StatusProps>): StatusProps {
  return {
    busy: false,
    apiReady: true,
    activeSkill: null,
    yolo: false,
    ctxTokens: 0,
    compactThreshold: 0,
    memoryItems: 0,
    phase: 'idle',
    transcriptFilter: 'all',
    expandHint: false,
    ...overrides,
  };
}

describe('formatElapsed', () => {
  it('formats seconds as mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(42)).toBe('0:42');
    expect(formatElapsed(125)).toBe('2:05');
    expect(formatElapsed(3700)).toBe('61:40');
  });
});

describe('StatusBar busy line', () => {
  it('names the running tool and shows the elapsed clock', () => {
    const { lastFrame } = render(
      <StatusBar
        {...props({
          busy: true,
          phase: 'running-tool',
          runningTool: 'Shell · HTTP request',
          elapsedSeconds: 42,
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Shell · HTTP request');
    expect(frame).toContain('0:42');
    expect(frame).toContain('Esc to cancel');
  });

  it('falls back to the phase word when no tool is running', () => {
    const { lastFrame } = render(
      <StatusBar {...props({ busy: true, phase: 'planning', elapsedSeconds: 3 })} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('planning');
    expect(frame).toContain('0:03');
  });
});

describe('StatusBar SuperMode badge', () => {
  it('shows SuperMode on the same line as the status (idle), pinned right', () => {
    const { lastFrame } = render(<StatusBar {...props({ yolo: true, apiReady: true })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SuperMode');
    // It shares the status row — the line with "ready" also carries it.
    const readyLine = frame.split('\n').find((l) => l.includes('ready')) ?? '';
    expect(readyLine).toContain('SuperMode');
    // …and it's pushed to the right of the status text (space-between).
    expect(readyLine.indexOf('SuperMode')).toBeGreaterThan(readyLine.indexOf('ready'));
  });

  it('shows SuperMode while busy too', () => {
    const { lastFrame } = render(<StatusBar {...props({ yolo: true, busy: true })} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SuperMode');
    expect(frame).toContain('Esc to cancel');
  });

  it('hides SuperMode when yolo is off', () => {
    const { lastFrame } = render(<StatusBar {...props({ yolo: false })} />);
    expect(lastFrame() ?? '').not.toContain('SuperMode');
  });
});
