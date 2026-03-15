import { describe, expect, it } from 'vitest';
import type { CliInvokeContext } from '../cli-strategy.js';
import {
  ADVERTISED_CODEX_CAPABILITIES,
  CODEX_RUNTIME_CAPABILITIES,
  createAdvertisedCodexCapabilities,
} from '../tool-capabilities.js';
import { createCodexStrategy } from './codex-strategy.js';

type InvokeContextOverrides = Omit<Partial<CliInvokeContext>, 'params'> & {
  params?: Partial<CliInvokeContext['params']>;
};

function createInvokeContext(overrides: InvokeContextOverrides = {}): CliInvokeContext {
  const base: CliInvokeContext = {
    params: {
      prompt: 'Hi',
      model: 'gpt-5.3-codex',
      cwd: '/tmp',
    },
    useStdin: false,
    hasImages: false,
  };

  return {
    ...base,
    ...overrides,
    params: {
      ...base.params,
      ...overrides.params,
    },
  };
}

describe('codex strategy capability contract', () => {
  it('keeps raw Codex affordances distinct from the conservative advertised profile', () => {
    const strategy = createCodexStrategy('gpt-5.3-codex');
    const advertised = createAdvertisedCodexCapabilities(strategy.capabilities);

    expect(strategy.capabilities).toEqual(CODEX_RUNTIME_CAPABILITIES);
    expect(strategy.capabilities).toContain('tools_fs');
    expect(strategy.capabilities).toContain('tools_exec');
    expect(strategy.capabilities).toContain('tools_web');
    expect(strategy.capabilities).toContain('workspace_instructions');
    expect(strategy.capabilities).toContain('mcp');
    expect([...advertised].sort()).toEqual([...ADVERTISED_CODEX_CAPABILITIES].sort());
  });
});

describe('codex strategy resumed-session args', () => {
  it('treats resumed turns as inheriting sandbox and workspace-scope restrictions', () => {
    const strategy = createCodexStrategy('gpt-5.3-codex');
    const ctx = createInvokeContext({
      params: {
        sessionKey: 'session-1',
        addDirs: ['/tmp/project', '/tmp/shared'],
      },
      sessionMap: new Map([['session-1', 'thread-1']]),
    });

    const args = strategy.buildArgs(ctx, {});

    expect(args.slice(0, 6)).toEqual([
      'exec',
      'resume',
      'thread-1',
      '-m',
      'gpt-5.3-codex',
      '--skip-git-repo-check',
    ]);
    expect(args).toContain('--json');
    expect(args).not.toContain('--ephemeral');
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--add-dir');
    expect(ctx.sessionResetReason).toBeUndefined();
  });

  it('keeps dangerous bypass explicit on resumed turns without reapplying read-only sandbox args', () => {
    const strategy = createCodexStrategy('gpt-5.3-codex');
    const ctx = createInvokeContext({
      params: {
        sessionKey: 'session-1',
      },
      sessionMap: new Map([['session-1', 'thread-1']]),
    });

    const args = strategy.buildArgs(ctx, {
      dangerouslySkipPermissions: true,
    });

    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('-s');
    expect(args).not.toContain('read-only');
  });

  it('resets to a fresh session when a resumed turn needs image flags', () => {
    const strategy = createCodexStrategy('gpt-5.3-codex');
    const ctx = createInvokeContext({
      params: {
        sessionKey: 'session-1',
      },
      sessionMap: new Map([['session-1', 'thread-1']]),
      tempImagePaths: ['/tmp/image-0.png'],
    });

    const args = strategy.buildArgs(ctx, {});

    expect(args).not.toContain('resume');
    expect(args).not.toContain('--ephemeral');
    expect(args).toContain('--json');
    expect(args).toContain('-s');
    expect(args).toContain('read-only');
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/image-0.png');
    expect(ctx.sessionResetReason).toBe(
      'image attachments require a fresh Codex session because `codex exec resume` does not support `--image`. Starting fresh.',
    );
  });
});

describe('codex strategy lifecycle callback', () => {
  it('emits additive lifecycle events while preserving parse behavior', () => {
    const lifecycleEvents: Array<{ eventType: string; threadId: string; turnId?: string }> = [];
    const sessionMap = new Map<string, string>();
    const ctx = createInvokeContext({
      params: {
        sessionKey: 'session-1',
      },
      sessionMap,
    });

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
    const ctx = createInvokeContext({
      params: {
        sessionKey: 'session-1',
      },
      sessionMap: new Map<string, string>(),
    });

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
