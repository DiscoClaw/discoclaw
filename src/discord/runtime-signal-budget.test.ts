import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { RuntimeSignalBudgetTracker } from './runtime-signal-budget.js';

describe('RuntimeSignalBudgetTracker preview_debug dedupe', () => {
  it('does not collapse distinct lifecycle events that share itemType but have different itemId', () => {
    const tracker = new RuntimeSignalBudgetTracker();

    const first = tracker.consume({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'command_execution',
      itemId: 'cmd-1',
    } as EngineEvent);
    const second = tracker.consume({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'command_execution',
      itemId: 'cmd-2',
    } as EngineEvent);

    expect(first).toEqual({ allow: true, appendSuppression: false, reason: 'guaranteed_signal' });
    expect(second).toEqual({ allow: true, appendSuppression: false, reason: 'guaranteed_signal' });
  });

  it('suppresses duplicate lifecycle chatter when the same itemId repeats', () => {
    const tracker = new RuntimeSignalBudgetTracker();

    const started = tracker.consume({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'reasoning',
      itemId: 'reason-1',
    } as EngineEvent);
    const duplicateStarted = tracker.consume({
      type: 'preview_debug',
      source: 'codex',
      phase: 'started',
      itemType: 'reasoning',
      itemId: 'reason-1',
    } as EngineEvent);
    const completed = tracker.consume({
      type: 'preview_debug',
      source: 'codex',
      phase: 'completed',
      itemType: 'reasoning',
      itemId: 'reason-1',
    } as EngineEvent);
    const duplicateCompleted = tracker.consume({
      type: 'preview_debug',
      source: 'codex',
      phase: 'completed',
      itemType: 'reasoning',
      itemId: 'reason-1',
    } as EngineEvent);

    expect(started).toEqual({ allow: true, appendSuppression: false, reason: 'guaranteed_signal' });
    expect(duplicateStarted).toEqual({ allow: false, appendSuppression: false, reason: 'duplicate_preview_debug' });
    expect(completed).toEqual({ allow: true, appendSuppression: false, reason: 'guaranteed_signal' });
    expect(duplicateCompleted).toEqual({ allow: false, appendSuppression: false, reason: 'duplicate_preview_debug' });
  });
});
