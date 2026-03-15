import { describe, expect, it } from 'vitest';
import type { RuntimeCapability } from './types.js';
import {
  ADVERTISED_CODEX_CAPABILITIES,
  CODEX_RUNTIME_CAPABILITIES,
  createAdvertisedCodexCapabilities,
} from './tool-capabilities.js';
import {
  STDIN_THRESHOLD,
  tryParseJsonLine,
  createEventQueue,
  SubprocessTracker,
  cliExecaEnv,
  collectPromptSafeCodexOrchestrationWording,
  formatPromptSafeCodexOrchestrationWording,
  stripAnsi,
  LineBuffer,
} from './cli-shared.js';

const COVERED_RUNTIME_CONFIGS = [
  {
    name: 'grounded cli',
    runtimeCapabilities: new Set(CODEX_RUNTIME_CAPABILITIES),
    expectedLines: [
      'Streams reply text through the RuntimeAdapter event channel.',
      'Supports retained Codex sessions when the runtime advertises sessions.',
    ],
  },
  {
    name: 'native app-server',
    runtimeCapabilities: new Set([...CODEX_RUNTIME_CAPABILITIES, 'mid_turn_steering']),
    expectedLines: [
      'Streams reply text through the RuntimeAdapter event channel.',
      'Supports retained Codex sessions when the runtime advertises sessions.',
      'Supports mid-turn steer and interrupt when the native app-server path is active.',
    ],
  },
  {
    name: 'sessions disabled',
    runtimeCapabilities: new Set(CODEX_RUNTIME_CAPABILITIES.filter((capability) => capability !== 'sessions')),
    expectedLines: [
      'Streams reply text through the RuntimeAdapter event channel.',
    ],
  },
] satisfies Array<{
  name: string;
  runtimeCapabilities: ReadonlySet<RuntimeCapability>;
  expectedLines: string[];
}>;

describe('STDIN_THRESHOLD', () => {
  it('is 100KB', () => {
    expect(STDIN_THRESHOLD).toBe(100_000);
  });
});

describe('tryParseJsonLine', () => {
  it('parses valid JSON', () => {
    expect(tryParseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseJsonLine('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParseJsonLine('')).toBeNull();
  });
});

describe('createEventQueue', () => {
  it('push + drain pattern works', async () => {
    const eq = createEventQueue();
    eq.push({ type: 'text_delta', text: 'hello' });
    eq.push({ type: 'done' });

    expect(eq.q.length).toBe(2);
    expect(eq.q.shift()!.type).toBe('text_delta');
    expect(eq.q.shift()!.type).toBe('done');
  });

  it('wait resolves when push is called', async () => {
    const eq = createEventQueue();
    let resolved = false;
    const p = eq.wait().then(() => { resolved = true; });
    expect(resolved).toBe(false);
    eq.push({ type: 'done' });
    await p;
    expect(resolved).toBe(true);
  });

  it('wake without pending wait is a no-op', () => {
    const eq = createEventQueue();
    // Should not throw.
    eq.wake();
  });
});

describe('SubprocessTracker', () => {
  it('killAll kills all tracked subprocesses', () => {
    const tracker = new SubprocessTracker();
    const killed: string[] = [];
    const mockProc = { kill: (sig: string) => { killed.push(sig); } } as any;
    tracker.add(mockProc);
    tracker.killAll();
    expect(killed).toEqual(['SIGKILL']);
  });

  it('killAll kills pools first, then subprocesses', () => {
    const tracker = new SubprocessTracker();
    const order: string[] = [];
    const mockPool = { killAll: () => { order.push('pool'); } };
    const mockProc = { kill: () => { order.push('proc'); } } as any;
    tracker.addPool(mockPool);
    tracker.add(mockProc);
    tracker.killAll();
    expect(order).toEqual(['pool', 'proc']);
  });

  it('delete removes subprocess from tracking', () => {
    const tracker = new SubprocessTracker();
    let killCount = 0;
    const mockProc = { kill: () => { killCount++; } } as any;
    tracker.add(mockProc);
    tracker.delete(mockProc);
    tracker.killAll();
    expect(killCount).toBe(0);
  });
});

describe('cliExecaEnv', () => {
  it('sets NO_COLOR, FORCE_COLOR, TERM defaults', () => {
    const env = cliExecaEnv();
    // Values are either from process.env or our defaults.
    expect(env.NO_COLOR).toBeDefined();
    expect(env.FORCE_COLOR).toBeDefined();
    expect(env.TERM).toBeDefined();
  });

  it('applies explicit overrides after process defaults', () => {
    const env = cliExecaEnv({ CODEX_HOME: '/tmp/codex-home-test', NO_COLOR: '0' });
    expect(env.CODEX_HOME).toBe('/tmp/codex-home-test');
    expect(env.NO_COLOR).toBe('0');
  });
});

describe('stripAnsi', () => {
  it('removes SGR color sequences', () => {
    expect(stripAnsi('\u001B[31mred\u001B[39m plain')).toBe('red plain');
  });

  it('removes OSC title sequences', () => {
    expect(stripAnsi('\u001B]0;window title\u0007hello')).toBe('hello');
  });

  it('removes DCS-style sequences', () => {
    expect(stripAnsi('start\u001BPpayload\u001B\\end')).toBe('startend');
  });
});

describe('LineBuffer', () => {
  it('splits lines and preserves trailing buffer', () => {
    const lb = new LineBuffer();
    const lines = lb.feed('line1\nline2\npartial');
    expect(lines).toEqual(['line1', 'line2']);
    expect(lb.flush()).toBe('partial');
  });

  it('handles \\r\\n line endings', () => {
    const lb = new LineBuffer();
    const lines = lb.feed('a\r\nb\r\n');
    expect(lines).toEqual(['a', 'b']);
    expect(lb.flush()).toBe('');
  });

  it('accumulates across multiple feeds', () => {
    const lb = new LineBuffer();
    expect(lb.feed('hel')).toEqual([]);
    expect(lb.feed('lo\nworld\n')).toEqual(['hello', 'world']);
  });

  it('flush returns empty string when buffer is empty', () => {
    const lb = new LineBuffer();
    lb.feed('complete\n');
    expect(lb.flush()).toBe('');
  });
});

describe('collectPromptSafeCodexOrchestrationWording', () => {
  it.each(COVERED_RUNTIME_CONFIGS)(
    'renders the audited runtime-facing wording for $name',
    ({ runtimeCapabilities, expectedLines }) => {
      expect(collectPromptSafeCodexOrchestrationWording(runtimeCapabilities)).toEqual(expectedLines);
    },
  );

  it('ignores transport-only capabilities even when raw runtime state includes them', () => {
    const wording = formatPromptSafeCodexOrchestrationWording(new Set(CODEX_RUNTIME_CAPABILITIES));

    expect(wording).not.toContain('command execution tools');
    expect(wording).not.toContain('file-system tools');
    expect(wording).not.toContain('web tools');
    expect(wording).not.toContain('workspace instructions');
    expect(wording).not.toContain('MCP tools');
    expect(wording).not.toMatch(/\bmay\b/i);
    expect(wording).not.toMatch(/not guaranteed/i);
  });

  it('matches the same wording whether input is raw runtime state or the advertised capability set', () => {
    const rawRuntimeCapabilities = new Set([...CODEX_RUNTIME_CAPABILITIES, 'mid_turn_steering'] as const);
    const rawWording = collectPromptSafeCodexOrchestrationWording(rawRuntimeCapabilities);
    const advertisedWording = collectPromptSafeCodexOrchestrationWording(
      createAdvertisedCodexCapabilities(rawRuntimeCapabilities),
    );

    expect(rawWording).toEqual(advertisedWording);
  });

  it('keeps runtime-facing ordering tied to the audited capability order instead of input set order', () => {
    const wording = collectPromptSafeCodexOrchestrationWording(
      new Set<RuntimeCapability>(['mid_turn_steering', 'sessions', 'streaming_text']),
    );

    expect(wording).toEqual([
      'Streams reply text through the RuntimeAdapter event channel.',
      'Supports retained Codex sessions when the runtime advertises sessions.',
      'Supports mid-turn steer and interrupt when the native app-server path is active.',
    ]);
  });

  it('does not advertise conditional capabilities that are absent from the audited set', () => {
    const wording = collectPromptSafeCodexOrchestrationWording(new Set(ADVERTISED_CODEX_CAPABILITIES));

    expect(wording).toEqual([
      'Streams reply text through the RuntimeAdapter event channel.',
      'Supports retained Codex sessions when the runtime advertises sessions.',
    ]);
    expect(formatPromptSafeCodexOrchestrationWording(new Set(['streaming_text']))).not.toContain(
      'retained Codex sessions',
    );
    expect(formatPromptSafeCodexOrchestrationWording(new Set(['streaming_text', 'sessions']))).not.toContain(
      'mid-turn steer and interrupt',
    );
  });
});
