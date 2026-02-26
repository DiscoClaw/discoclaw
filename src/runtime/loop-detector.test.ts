import { describe, expect, it, vi } from 'vitest';

import { LoopDetector } from './loop-detector.js';
import type { EngineEvent } from './types.js';

function toolStart(name: string, input?: unknown): EngineEvent {
  return { type: 'tool_start', name, input };
}

describe('LoopDetector', () => {
  it('ignores non-tool_start events', () => {
    const onWarn = vi.fn();
    const onCritical = vi.fn();
    const det = new LoopDetector({ warnThreshold: 2, criticalThreshold: 3, onWarn, onCritical });

    for (let i = 0; i < 20; i++) {
      det.onEvent({ type: 'text_delta', text: 'hello' });
      det.onEvent({ type: 'done' });
    }

    expect(onWarn).not.toHaveBeenCalled();
    expect(onCritical).not.toHaveBeenCalled();
  });

  describe('consecutive identical calls', () => {
    it('fires onWarn at warnThreshold', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 4, criticalThreshold: 10, onWarn });

      for (let i = 0; i < 4; i++) {
        det.onEvent(toolStart('Read', { path: '/foo.ts' }));
      }

      // Both consecutive and frequency patterns fire independently.
      expect(onWarn).toHaveBeenCalled();
      expect(onWarn.mock.calls.some((c: string[]) => c[0].includes('Read'))).toBe(true);
    });

    it('fires onCritical at criticalThreshold', () => {
      const onCritical = vi.fn();
      const det = new LoopDetector({ warnThreshold: 3, criticalThreshold: 6, windowSize: 20, onCritical });

      for (let i = 0; i < 6; i++) {
        det.onEvent(toolStart('Read', { path: '/foo.ts' }));
      }

      expect(onCritical).toHaveBeenCalled();
      expect(onCritical.mock.calls[0]![0]).toContain('loop detected');
    });

    it('does not re-fire warn or critical for the same pattern key', () => {
      const onWarn = vi.fn();
      const onCritical = vi.fn();
      const det = new LoopDetector({ warnThreshold: 3, criticalThreshold: 5, windowSize: 20, onWarn, onCritical });

      for (let i = 0; i < 10; i++) {
        det.onEvent(toolStart('Grep', { q: 'x' }));
      }

      // Each pattern type (consecutive, frequency) fires warn/critical at most once.
      // With identical calls, both consecutive and frequency trigger = 2 warns, 2 criticals.
      expect(onWarn).toHaveBeenCalledTimes(2);
      expect(onCritical).toHaveBeenCalledTimes(2);
    });
  });

  describe('ping-pong detection', () => {
    it('detects alternating A-B-A-B pattern', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 4, criticalThreshold: 20, windowSize: 20, onWarn });

      // Need enough alternations: each pair is 2 events, threshold checks pair-count * 2
      // warnThreshold=4: we need pairs*2 >= 4, so pairs >= 2 means 4 events (A-B-A-B)
      for (let i = 0; i < 4; i++) {
        det.onEvent(toolStart('Read', { path: '/a' }));
        det.onEvent(toolStart('Write', { path: '/a', content: 'x' }));
      }

      const ppCall = onWarn.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('ping-pong'),
      );
      expect(ppCall).toBeDefined();
    });

    it('does not fire for non-alternating mixed calls', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 6, criticalThreshold: 20, windowSize: 20, onWarn });

      // Mixed pattern: A-B-C-A-B-C — not a simple ping-pong
      for (let i = 0; i < 3; i++) {
        det.onEvent(toolStart('Read', { path: '/a' }));
        det.onEvent(toolStart('Write', { path: '/b' }));
        det.onEvent(toolStart('Grep', { q: 'c' }));
      }

      const ppCall = onWarn.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('ping-pong'),
      );
      expect(ppCall).toBeUndefined();
    });
  });

  describe('frequency within window', () => {
    it('fires when a single tool dominates the window', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 5, criticalThreshold: 20, windowSize: 10, onWarn });

      // Interleave enough of the same call amid others to hit frequency threshold.
      for (let i = 0; i < 5; i++) {
        det.onEvent(toolStart('Bash', { cmd: 'ls' }));
        if (i < 4) det.onEvent(toolStart('Read', { path: `/file${i}` }));
      }

      const freqCall = onWarn.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('Bash'),
      );
      expect(freqCall).toBeDefined();
    });

    it('does not fire below threshold', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 8, criticalThreshold: 15, windowSize: 20, onWarn });

      // Only 3 calls of the same tool — well below threshold 8.
      for (let i = 0; i < 3; i++) {
        det.onEvent(toolStart('Bash', { cmd: 'ls' }));
        det.onEvent(toolStart('Read', { path: `/file${i}` }));
      }

      expect(onWarn).not.toHaveBeenCalled();
    });
  });

  describe('window sliding', () => {
    it('old entries fall out of the window', () => {
      const onWarn = vi.fn();
      const onCritical = vi.fn();
      const det = new LoopDetector({ warnThreshold: 4, criticalThreshold: 6, windowSize: 5, onWarn, onCritical });

      // Fill with 3 identical calls (below warn=4).
      for (let i = 0; i < 3; i++) {
        det.onEvent(toolStart('Read', { path: '/a' }));
      }
      expect(onWarn).not.toHaveBeenCalled();

      // Push different calls to evict old ones.
      for (let i = 0; i < 5; i++) {
        det.onEvent(toolStart('Write', { path: `/b${i}` }));
      }

      // Now add 3 more Read calls — old Reads have been evicted, so frequency stays at 3.
      for (let i = 0; i < 3; i++) {
        det.onEvent(toolStart('Read', { path: '/a' }));
      }

      // frequency-based warn for Read should not fire because window only has 3.
      // (consecutive will fire at 3 if threshold were 3, but we set it to 4)
      const freqCalls = onWarn.mock.calls.filter(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('frequency') && c[0].includes('Read'),
      );
      expect(freqCalls).toHaveLength(0);
    });
  });

  describe('different inputs produce different signatures', () => {
    it('does not trigger for same tool with varying inputs', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 3, criticalThreshold: 6, windowSize: 20, onWarn });

      for (let i = 0; i < 10; i++) {
        det.onEvent(toolStart('Read', { path: `/file${i}.ts` }));
      }

      // Consecutive check should not fire because each input is different.
      const consecutiveCalls = onWarn.mock.calls.filter(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('consecutive'),
      );
      expect(consecutiveCalls).toHaveLength(0);
    });
  });

  describe('dispose', () => {
    it('resets state so no further callbacks fire', () => {
      const onWarn = vi.fn();
      const det = new LoopDetector({ warnThreshold: 3, criticalThreshold: 6, windowSize: 20, onWarn });

      for (let i = 0; i < 2; i++) {
        det.onEvent(toolStart('Read', { path: '/a' }));
      }

      det.dispose();

      // After dispose, adding more events should start fresh — 1 more call won't reach threshold 3.
      det.onEvent(toolStart('Read', { path: '/a' }));

      expect(onWarn).not.toHaveBeenCalled();
    });
  });

  describe('default thresholds', () => {
    it('uses defaults when no options provided', () => {
      const onCritical = vi.fn();
      const det = new LoopDetector({ onCritical });

      // Default criticalThreshold is 15 — send 15 identical events.
      for (let i = 0; i < 15; i++) {
        det.onEvent(toolStart('Bash', { cmd: 'echo hi' }));
      }

      // Both consecutive and frequency patterns fire.
      expect(onCritical).toHaveBeenCalled();
      expect(onCritical.mock.calls[0]![0]).toContain('loop detected');
    });
  });
});
