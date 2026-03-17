import { describe, expect, it } from 'vitest';
import { buildStopSummary } from './stop-summary.js';
import type { AbortSnapshot } from './abort-registry.js';

function makeSnapshot(overrides?: Partial<AbortSnapshot>): AbortSnapshot {
  return {
    messageId: '123456789012345678',
    channelId: '987654321098765432',
    userMessage: 'Tell me about TypeScript generics',
    partialResponse: 'TypeScript generics allow you to create reusable',
    activityLabel: 'Generating response',
    sessionKey: 'test-session',
    elapsedMs: 5400,
    ...overrides,
  };
}

describe('buildStopSummary', () => {
  it('returns empty string for empty snapshots and no forge cancellation', () => {
    expect(buildStopSummary([])).toBe('');
  });

  it('returns empty string for empty snapshots without forgeCancelled option', () => {
    expect(buildStopSummary([], {})).toBe('');
    expect(buildStopSummary([], { forgeCancelled: false })).toBe('');
  });

  it('formats a single snapshot correctly', () => {
    const snap = makeSnapshot();
    const result = buildStopSummary([snap]);

    expect(result).toContain('**Stop summary:**');
    expect(result).toContain('**Request:** "Tell me about TypeScript generics"');
    expect(result).toContain('**Activity:** Generating response');
    expect(result).toContain('**Duration:** 5s');
    expect(result).toContain('**Partial output:**');
    expect(result).toContain('chars streamed');
  });

  it('formats multiple snapshots with stream count', () => {
    const snap1 = makeSnapshot({ userMessage: 'First request', elapsedMs: 3000 });
    const snap2 = makeSnapshot({ userMessage: 'Second request', elapsedMs: 7000 });
    const result = buildStopSummary([snap1, snap2]);

    expect(result).toContain('**Stop summary** (2 streams):');
    expect(result).toContain('**Stream 1:**');
    expect(result).toContain('**Stream 2:**');
    expect(result).toContain('First request');
    expect(result).toContain('Second request');
  });

  it('shows "none yet" when partial response is empty', () => {
    const snap = makeSnapshot({ partialResponse: '' });
    const result = buildStopSummary([snap]);

    expect(result).toContain('**Output:** none yet');
    expect(result).not.toContain('chars streamed');
  });

  it('shows "none yet" when partial response is whitespace-only', () => {
    const snap = makeSnapshot({ partialResponse: '   \n  ' });
    const result = buildStopSummary([snap]);

    expect(result).toContain('**Output:** none yet');
  });

  it('truncates long user messages to 80 chars', () => {
    const longMessage = 'a'.repeat(120);
    const snap = makeSnapshot({ userMessage: longMessage });
    const result = buildStopSummary([snap]);

    // Should truncate at 79 chars + ellipsis
    expect(result).toContain('\u2026"');
    expect(result).not.toContain(longMessage);
  });

  it('omits activity label when absent', () => {
    const snap = makeSnapshot({ activityLabel: '' });
    const result = buildStopSummary([snap]);

    expect(result).not.toContain('**Activity:**');
  });

  it('includes forge cancellation notice', () => {
    const snap = makeSnapshot();
    const result = buildStopSummary([snap], { forgeCancelled: true });

    expect(result).toContain('**Forge:** cancel requested');
  });

  it('shows forge cancellation even with no snapshots', () => {
    const result = buildStopSummary([], { forgeCancelled: true });

    expect(result).toContain('**Forge:** cancel requested');
    expect(result).not.toContain('**Stop summary');
  });

  it('formats elapsed time correctly for sub-second durations', () => {
    const snap = makeSnapshot({ elapsedMs: 500 });
    const result = buildStopSummary([snap]);

    expect(result).toContain('**Duration:** <1s');
  });

  it('formats elapsed time correctly for minute+ durations', () => {
    const snap = makeSnapshot({ elapsedMs: 125000 }); // 2m 5s
    const result = buildStopSummary([snap]);

    expect(result).toContain('**Duration:** 2m 5s');
  });

  it('formats elapsed time for exact minutes', () => {
    const snap = makeSnapshot({ elapsedMs: 120000 }); // 2m 0s
    const result = buildStopSummary([snap]);

    expect(result).toContain('**Duration:** 2m');
  });

  it('collapses newlines in user messages', () => {
    const snap = makeSnapshot({ userMessage: 'line one\nline two\r\nline three' });
    const result = buildStopSummary([snap]);

    expect(result).toContain('line one line two line three');
    expect(result).not.toContain('\n"');
  });
});
