import { describe, it, expect, vi } from 'vitest';
import { runTestCase, runSuite } from '../runner.js';
import type { FrozenTestCase } from '../types.js';
import type { EngineEvent, RuntimeAdapter, RuntimeCapability, RuntimeId } from '../../runtime/types.js';

// ── Mock adapter factory ────────────────────────────────────────────

function mockAdapter(events: EngineEvent[]): RuntimeAdapter {
  return {
    id: 'other' as RuntimeId,
    capabilities: new Set<RuntimeCapability>(['streaming_text']),
    defaultModel: 'test-model',
    invoke: async function* () {
      for (const evt of events) {
        yield evt;
      }
    },
  };
}

const TC: FrozenTestCase = {
  id: 'tc-run-1',
  prompt: 'list channels',
  expectedActions: [{ type: 'channelList' }],
};

// ── runTestCase ─────────────────────────────────────────────────────

describe('runTestCase', () => {
  it('accumulates text from text_delta events', async () => {
    const adapter = mockAdapter([
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'done' },
    ]);
    const result = await runTestCase(TC, 'instructions here', adapter);
    expect(result.text).toBe('Hello world');
    expect(result.testCaseId).toBe('tc-run-1');
  });

  it('uses text_final as the authoritative text', async () => {
    const adapter = mockAdapter([
      { type: 'text_delta', text: 'partial' },
      { type: 'text_final', text: 'the final answer' },
      { type: 'done' },
    ]);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(result.text).toBe('the final answer');
  });

  it('stops accumulating deltas after text_final', async () => {
    const adapter = mockAdapter([
      { type: 'text_delta', text: 'first' },
      { type: 'text_final', text: 'final' },
      { type: 'text_delta', text: ' extra' },
      { type: 'done' },
    ]);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(result.text).toBe('final');
  });

  it('extracts actions from <discord-action> blocks in final text', async () => {
    const text = 'Here are the channels:\n<discord-action>{"type":"channelList"}</discord-action>';
    const adapter = mockAdapter([
      { type: 'text_final', text },
      { type: 'done' },
    ]);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe('channelList');
    expect(result.parseFailures).toBe(0);
  });

  it('collects all engine events', async () => {
    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'hi' },
      { type: 'tool_start', name: 'test_tool' },
      { type: 'tool_end', name: 'test_tool', ok: true },
      { type: 'done' },
    ];
    const adapter = mockAdapter(events);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(result.events).toHaveLength(4);
    expect(result.events[1]).toEqual({ type: 'tool_start', name: 'test_tool' });
  });

  it('handles error events without crashing', async () => {
    const adapter = mockAdapter([
      { type: 'text_delta', text: 'before error' },
      { type: 'error', message: 'something failed' },
      { type: 'done' },
    ]);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(result.text).toBe('before error');
    expect(result.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('records duration in milliseconds', async () => {
    const adapter = mockAdapter([{ type: 'done' }]);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty actions when text has no action blocks', async () => {
    const adapter = mockAdapter([
      { type: 'text_final', text: 'just plain text, no actions here' },
      { type: 'done' },
    ]);
    const result = await runTestCase(TC, 'instructions', adapter);
    expect(result.actions).toEqual([]);
  });
});

// ── runSuite ────────────────────────────────────────────────────────

describe('runSuite', () => {
  const cases: FrozenTestCase[] = [
    { id: 'suite-1', prompt: 'list channels', expectedActions: [{ type: 'channelList' }] },
    { id: 'suite-2', prompt: 'send hello', expectedActions: [{ type: 'sendMessage' }] },
  ];

  it('runs all test cases and returns results', async () => {
    const adapter = mockAdapter([
      { type: 'text_final', text: '<discord-action>{"type":"channelList"}</discord-action>' },
      { type: 'done' },
    ]);
    const { results, actionsMap } = await runSuite(cases, 'instructions', adapter);
    expect(results).toHaveLength(2);
    expect(actionsMap.size).toBe(2);
    expect(actionsMap.has('suite-1')).toBe(true);
    expect(actionsMap.has('suite-2')).toBe(true);
  });

  it('maps test case IDs to extracted actions', async () => {
    const adapter = mockAdapter([
      { type: 'text_final', text: '<discord-action>{"type":"channelList"}</discord-action>' },
      { type: 'done' },
    ]);
    const { actionsMap } = await runSuite(cases, 'instructions', adapter);
    // Both cases get the same adapter output, so both should have channelList
    const actions = actionsMap.get('suite-1')!;
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('channelList');
  });

  it('returns empty results for empty suite', async () => {
    const adapter = mockAdapter([{ type: 'done' }]);
    const { results, actionsMap } = await runSuite([], 'instructions', adapter);
    expect(results).toEqual([]);
    expect(actionsMap.size).toBe(0);
  });
});
