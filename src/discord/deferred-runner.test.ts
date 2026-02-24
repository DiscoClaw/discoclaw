import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalMetrics } from '../observability/metrics.js';
import type { EngineEvent } from '../runtime/types.js';
import { configureDeferredScheduler } from './deferred-runner.js';
import type { StatusPoster } from './status-channel.js';

vi.mock('./prompt-common.js', () => ({
  loadWorkspacePaFiles: vi.fn(async () => []),
  buildContextFiles: vi.fn(() => []),
  inlineContextFiles: vi.fn(async () => ''),
  resolveEffectiveTools: vi.fn(async () => ({
    effectiveTools: [],
    permissionNote: null,
    runtimeCapabilityNote: null,
  })),
  buildPromptPreamble: vi.fn(() => ''),
}));

vi.mock('./actions.js', () => ({
  parseDiscordActions: vi.fn(() => ({
    actions: [],
    cleanText: '',
    strippedUnrecognizedTypes: [],
    parseFailures: 0,
  })),
  executeDiscordActions: vi.fn(async () => []),
  discordActionsPromptSection: vi.fn(() => ''),
  buildDisplayResultLines: vi.fn(() => []),
}));

vi.mock('./action-utils.js', () => ({
  resolveChannel: vi.fn(() => ({ id: 'ch-1', send: vi.fn(async () => ({})) })),
  fmtTime: vi.fn(() => '12:00'),
}));

vi.mock('./channel-context.js', () => ({
  resolveDiscordChannelContext: vi.fn(() => ({ contextPath: undefined, channelName: 'general' })),
}));

vi.mock('./output-common.js', () => ({
  appendUnavailableActionTypesNotice: vi.fn((text: string) => text),
  appendParseFailureNotice: vi.fn((text: string) => text),
}));

vi.mock('../runtime/model-tiers.js', () => ({
  resolveModel: vi.fn((model: string) => model),
}));

vi.mock('./user-errors.js', () => ({
  mapRuntimeErrorToUserMessage: vi.fn((msg: string) => msg),
}));

function makeRuntime(events: EngineEvent[]) {
  return {
    id: 'test',
    capabilities: new Set() as ReadonlySet<never>,
    async *invoke(): AsyncIterable<EngineEvent> {
      for (const evt of events) yield evt;
    },
  };
}

function makeThrowingRuntime(error: Error) {
  return {
    id: 'test',
    capabilities: new Set() as ReadonlySet<never>,
    async *invoke(): AsyncIterable<EngineEvent> {
      throw error;
    },
  };
}

function makeState() {
  return {
    runtimeModel: 'fast',
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
  };
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    maxDelaySeconds: 3600,
    maxConcurrent: 5,
    state: makeState(),
    runtime: makeRuntime([{ type: 'text_final', text: 'Hello' } as EngineEvent, { type: 'done' } as EngineEvent]),
    runtimeTools: [],
    runtimeTimeoutMs: 30_000,
    workspaceCwd: '/tmp/workspace',
    useGroupDirCwd: false,
    botDisplayName: 'Discoclaw',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as Parameters<typeof configureDeferredScheduler>[0];
}

function makeContext() {
  return {
    guild: { id: 'guild-1' },
    client: { channels: { cache: new Map() } },
    channelId: 'ch-1',
    messageId: 'm-1',
    threadParentId: null,
    confirmation: { mode: 'automated' as const },
  };
}

function makeAction() {
  return {
    type: 'defer' as const,
    channel: 'ch-1',
    prompt: 'do the thing',
    delaySeconds: 1,
  };
}

function makeStatusPoster(): StatusPoster {
  return {
    online: vi.fn(),
    offline: vi.fn(),
    runtimeError: vi.fn().mockResolvedValue(undefined),
    handlerError: vi.fn(),
    actionFailed: vi.fn().mockResolvedValue(undefined),
    taskSyncComplete: vi.fn(),
  };
}

describe('deferred-runner observability', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runtime error event increments invoke.defer.failed and calls status.runtimeError', async () => {
    const recordInvokeStart = vi.spyOn(globalMetrics, 'recordInvokeStart');
    const recordInvokeResult = vi.spyOn(globalMetrics, 'recordInvokeResult');

    const status = makeStatusPoster();
    const opts = makeOpts({
      runtime: makeRuntime([{ type: 'error', message: 'timeout reached' } as EngineEvent]),
      status,
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(recordInvokeStart).toHaveBeenCalledWith('defer');
    expect(recordInvokeResult).toHaveBeenCalledWith('defer', expect.any(Number), false, 'timeout reached');
    expect(status.runtimeError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'defer:ch-1' }),
      'timeout reached',
    );
  });

  it('runtime throw records failure metrics and calls status poster', async () => {
    const recordInvokeResult = vi.spyOn(globalMetrics, 'recordInvokeResult');

    const status = makeStatusPoster();
    const opts = makeOpts({
      runtime: makeThrowingRuntime(new Error('network fail')),
      status,
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(recordInvokeResult).toHaveBeenCalledWith('defer', expect.any(Number), false, 'network fail');
    expect(status.runtimeError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'defer:ch-1' }),
      'network fail',
    );
  });

  it('successful invoke records invoke.defer.started and invoke.defer.succeeded with latency', async () => {
    const recordInvokeStart = vi.spyOn(globalMetrics, 'recordInvokeStart');
    const recordInvokeResult = vi.spyOn(globalMetrics, 'recordInvokeResult');

    const opts = makeOpts({
      runtime: makeRuntime([{ type: 'text_final', text: 'Hello!' } as EngineEvent, { type: 'done' } as EngineEvent]),
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(recordInvokeStart).toHaveBeenCalledWith('defer');
    expect(recordInvokeResult).toHaveBeenCalledWith('defer', expect.any(Number), true);
  });

  it('action results call recordActionResult and status.actionFailed for failures', async () => {
    const { parseDiscordActions, executeDiscordActions } = await import('./actions.js');
    (parseDiscordActions as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      actions: [{ type: 'sendMessage', content: 'hello' }],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    (executeDiscordActions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ok: false, error: 'Permission denied' },
    ]);

    const recordActionResult = vi.spyOn(globalMetrics, 'recordActionResult');
    const status = makeStatusPoster();
    const opts = makeOpts({ status });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(recordActionResult).toHaveBeenCalledWith(false);
    expect(status.actionFailed).toHaveBeenCalledWith('sendMessage', 'Permission denied');
  });

  it('null status does not throw on runtime error', async () => {
    const opts = makeOpts({
      runtime: makeRuntime([{ type: 'error', message: 'oops' } as EngineEvent]),
      status: null,
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });

    await expect(vi.advanceTimersByTimeAsync(2000)).resolves.not.toThrow();
  });
});
