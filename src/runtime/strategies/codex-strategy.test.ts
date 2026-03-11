import { describe, expect, it } from 'vitest';
import type { CliInvokeContext } from '../cli-strategy.js';
import { createCodexStrategy } from './codex-strategy.js';

describe('codex strategy lifecycle callback', () => {
  it('emits additive lifecycle events while preserving parse behavior', () => {
    const lifecycleEvents: Array<{ eventType: string; threadId: string; turnId?: string }> = [];
    const sessionMap = new Map<string, string>();
    const ctx: CliInvokeContext = {
      params: {
        prompt: 'Hi',
        model: 'gpt-5.3-codex',
        cwd: '/tmp',
        sessionKey: 'session-1',
      },
      useStdin: false,
      hasImages: false,
      sessionMap,
    };

    const strategy = createCodexStrategy('gpt-5.3-codex', {
      onLifecycleEvent(event) {
        lifecycleEvents.push(event);
      },
    });

    expect(strategy.parseLine?.({
      type: 'thread.started',
      thread_id: 'thread-1',
    }, ctx)).toEqual({});
    expect(sessionMap.get('session-1')).toBe('thread-1');

    expect(strategy.parseLine?.({
      type: 'turn.completed',
      turn_id: 'turn-1',
      usage: {},
    }, ctx)).toEqual({
      activity: true,
      extraEvents: [{ type: 'usage' }],
    });

    expect(lifecycleEvents).toEqual([
      { eventType: 'thread.started', threadId: 'thread-1' },
      { eventType: 'turn.completed', threadId: 'thread-1', turnId: 'turn-1' },
    ]);
  });

  it('swallows lifecycle callback failures', () => {
    const ctx: CliInvokeContext = {
      params: {
        prompt: 'Hi',
        model: 'gpt-5.3-codex',
        cwd: '/tmp',
        sessionKey: 'session-1',
      },
      useStdin: false,
      hasImages: false,
      sessionMap: new Map<string, string>(),
    };

    const strategy = createCodexStrategy('gpt-5.3-codex', {
      onLifecycleEvent() {
        throw new Error('boom');
      },
    });

    expect(() => strategy.parseLine?.({
      type: 'thread.started',
      thread_id: 'thread-1',
    }, ctx)).not.toThrow();
    expect(ctx.sessionMap?.get('session-1')).toBe('thread-1');
  });
});
