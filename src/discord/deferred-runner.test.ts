import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalMetrics } from '../observability/metrics.js';
import type { EngineEvent } from '../runtime/types.js';
import { configureDeferredScheduler } from './deferred-runner.js';
import type { StatusPoster } from './status-channel.js';

vi.mock('./prompt-common.js', () => ({
  loadWorkspacePaFiles: vi.fn(async () => []),
  buildContextFiles: vi.fn(() => []),
  inlineContextFilesWithMeta: vi.fn(async () => ({ text: '', sections: [] })),
  resolveEffectiveTools: vi.fn(async () => ({
    effectiveTools: [],
    permissionNote: null,
    runtimeCapabilityNote: null,
  })),
  buildPromptPreamble: vi.fn(() => ''),
  buildOpenTasksSection: vi.fn(() => ''),
  buildPromptSectionEstimates: vi.fn(() => ({
    sections: {},
    totalChars: 0,
    totalEstTokens: 0,
  })),
}));

vi.mock('./actions.js', () => ({
  parseDiscordActions: vi.fn(() => ({
    actions: [],
    cleanText: '',
    strippedUnrecognizedTypes: [],
    parseFailures: 0,
  })),
  executeDiscordActions: vi.fn(async () => []),
  buildTieredDiscordActionsPromptSection: vi.fn(() => ({
    prompt: '',
    includedCategories: [],
    tierBuckets: { core: [], channelContextual: [], keywordTriggered: [] },
    keywordHits: [],
  })),
  buildDisplayResultLines: vi.fn(() => []),
  appendActionResults: vi.fn((body: string) => body),
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
    deferMaxDepth: 4,
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

  it('injects buildOpenTasksSection result into prompt', async () => {
    const { buildOpenTasksSection } = await import('./prompt-common.js');
    const mockBuildOpenTasks = buildOpenTasksSection as ReturnType<typeof vi.fn>;
    mockBuildOpenTasks.mockClear();
    mockBuildOpenTasks.mockReturnValue('Open tasks:\nws-001: open, "Test task"\n');

    const taskStore = { getAll: vi.fn(() => []) };
    const invokeSpy = vi.fn();
    const runtime = {
      id: 'test',
      capabilities: new Set() as ReadonlySet<never>,
      async *invoke(p: unknown): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' } as EngineEvent;
        yield { type: 'done' } as EngineEvent;
      },
    };
    const opts = makeOpts({
      runtime,
      state: { ...makeState(), taskCtx: { store: taskStore } },
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockBuildOpenTasks).toHaveBeenCalledWith(taskStore);
    const prompt: string = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('Open tasks:');
    expect(prompt).toContain('ws-001: open, "Test task"');
  });

  it('uses tiered action schema prompt selection with deferred channel context', async () => {
    const { buildTieredDiscordActionsPromptSection } = await import('./actions.js');
    const mockBuildTiered = buildTieredDiscordActionsPromptSection as ReturnType<typeof vi.fn>;
    mockBuildTiered.mockClear();
    mockBuildTiered.mockReturnValue({
      prompt: '### Messaging',
      includedCategories: ['messaging'],
      tierBuckets: { core: ['messaging'], channelContextual: [], keywordTriggered: [] },
      keywordHits: ['send'],
    });

    const { resolveDiscordChannelContext } = await import('./channel-context.js');
    (resolveDiscordChannelContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      contextPath: '/tmp/channel-context.md',
      channelName: 'ops',
    });

    const invokeSpy = vi.fn();
    const runtime = {
      id: 'test',
      capabilities: new Set() as ReadonlySet<never>,
      async *invoke(p: unknown): AsyncIterable<EngineEvent> {
        invokeSpy(p);
        yield { type: 'text_final', text: 'ok' } as EngineEvent;
        yield { type: 'done' } as EngineEvent;
      },
    };

    const opts = makeOpts({
      runtime,
      state: {
        ...makeState(),
        discordActionsEnabled: true,
        discordActionsMessaging: true,
        discordActionsChannels: true,
      },
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockBuildTiered).toHaveBeenCalledWith(
      expect.objectContaining({
        messaging: true,
        channels: true,
      }),
      'Discoclaw',
      expect.objectContaining({
        channelName: 'ops',
        channelContextPath: '/tmp/channel-context.md',
        isThread: false,
        userText: 'do the thing',
      }),
    );
    const prompt: string = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('### Messaging');
  });

  it('logs deferred prompt section estimate payload with action schema selection', async () => {
    const { inlineContextFilesWithMeta, buildPromptSectionEstimates } = await import('./prompt-common.js');
    const mockInlineContext = inlineContextFilesWithMeta as ReturnType<typeof vi.fn>;
    const mockBuildEstimates = buildPromptSectionEstimates as ReturnType<typeof vi.fn>;
    mockInlineContext.mockClear();
    mockBuildEstimates.mockClear();

    mockInlineContext.mockResolvedValueOnce({
      text: '--- AGENTS.md ---\nContext',
      sections: [{
        filePath: '/tmp/AGENTS.md',
        fileName: 'AGENTS.md',
        rendered: '--- AGENTS.md ---\nContext',
        chars: 24,
      }],
    });
    const estimatePayload = {
      sections: { pa: { chars: 24, estTokens: 6, included: true } },
      totalChars: 50,
      totalEstTokens: 13,
    };
    mockBuildEstimates.mockReturnValueOnce(estimatePayload);

    const { buildTieredDiscordActionsPromptSection } = await import('./actions.js');
    const mockBuildTiered = buildTieredDiscordActionsPromptSection as ReturnType<typeof vi.fn>;
    mockBuildTiered.mockClear();
    mockBuildTiered.mockReturnValue({
      prompt: '### Messaging',
      includedCategories: ['messaging', 'channels'],
      tierBuckets: {
        core: ['messaging', 'channels'],
        channelContextual: ['tasks'],
        keywordTriggered: ['memory'],
      },
      keywordHits: ['remember'],
    });

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const opts = makeOpts({
      log,
      state: {
        ...makeState(),
        discordActionsEnabled: true,
        discordActionsMessaging: true,
        discordActionsChannels: true,
      },
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockBuildEstimates).toHaveBeenCalledWith(expect.objectContaining({
      contextSections: expect.any(Array),
      actionsReferenceSection: '### Messaging',
    }));

    const infoCalls = log.info.mock.calls;
    const estimateCall = infoCalls.find((call: any[]) => call[1] === 'defer:prompt:section-estimates');
    expect(estimateCall).toBeTruthy();
    expect(estimateCall![0]).toEqual(expect.objectContaining({
      flow: 'defer',
      channelId: 'ch-1',
      sections: estimatePayload.sections,
      totalChars: estimatePayload.totalChars,
      totalEstTokens: estimatePayload.totalEstTokens,
      actionSchemaSelection: expect.objectContaining({
        includedCategories: expect.arrayContaining(['messaging', 'channels']),
        tierBuckets: expect.objectContaining({
          core: expect.arrayContaining(['messaging', 'channels']),
          channelContextual: expect.any(Array),
          keywordTriggered: expect.any(Array),
        }),
        keywordHits: expect.arrayContaining(['remember']),
      }),
    }));
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

  it('flags have defer: true when depth is below maxDepth', async () => {
    const { parseDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;
    mockParse.mockClear();
    mockParse.mockReturnValue({
      actions: [],
      cleanText: 'ok',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const opts = makeOpts({ deferMaxDepth: 4 });
    const scheduler = configureDeferredScheduler(opts);
    // context with no deferDepth (defaults to 0) → depth becomes 1, which is < 4
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    const flags = mockParse.mock.calls[0][1];
    expect(flags.defer).toBe(true);
  });

  it('flags have defer: false when depth equals maxDepth', async () => {
    const { parseDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;
    mockParse.mockClear();
    mockParse.mockReturnValue({
      actions: [],
      cleanText: 'ok',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const opts = makeOpts({ deferMaxDepth: 4 });
    const scheduler = configureDeferredScheduler(opts);
    // context with deferDepth 3 → depth becomes 4, which equals maxDepth
    const ctx = { ...makeContext(), deferDepth: 3 };
    scheduler.schedule({ action: makeAction(), context: ctx as any });
    await vi.advanceTimersByTimeAsync(2000);

    const flags = mockParse.mock.calls[0][1];
    expect(flags.defer).toBe(false);
  });

  it('actCtx carries deferDepth incremented by 1 from incoming context', async () => {
    const { parseDiscordActions, executeDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;
    const mockExecute = executeDiscordActions as ReturnType<typeof vi.fn>;
    mockParse.mockClear();
    mockExecute.mockClear();

    mockParse.mockReturnValue({
      actions: [{ type: 'sendMessage', content: 'hi' }],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    mockExecute.mockResolvedValue([{ ok: true, summary: 'sent' }]);

    const opts = makeOpts({ deferMaxDepth: 4 });
    const scheduler = configureDeferredScheduler(opts);
    const ctx = { ...makeContext(), deferDepth: 2 };
    scheduler.schedule({ action: makeAction(), context: ctx as any });
    await vi.advanceTimersByTimeAsync(2000);

    const actCtx = mockExecute.mock.calls[0][1];
    expect(actCtx.deferDepth).toBe(3);
  });

  it('missing guild posts status notice via handlerError', async () => {
    const status = makeStatusPoster();
    const opts = makeOpts({ status });

    const scheduler = configureDeferredScheduler(opts);
    const ctx = { ...makeContext(), guild: null };
    scheduler.schedule({ action: makeAction(), context: ctx as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(status.handlerError).toHaveBeenCalledWith(
      { sessionKey: 'defer' },
      'deferred run skipped: no guild context',
    );
  });

  it('unresolvable channel posts status notice via handlerError', async () => {
    const { resolveChannel } = await import('./action-utils.js');
    (resolveChannel as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const status = makeStatusPoster();
    const opts = makeOpts({ status });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(status.handlerError).toHaveBeenCalledWith(
      { sessionKey: 'defer:ch-1' },
      'deferred run skipped: channel "ch-1" not found',
    );
  });

  it('channel not in allowlist posts status notice via handlerError', async () => {
    const status = makeStatusPoster();
    const opts = makeOpts({
      status,
      state: { ...makeState(), allowChannelIds: new Set(['other-channel']) },
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(status.handlerError).toHaveBeenCalledWith(
      { sessionKey: 'defer:ch-1' },
      'deferred run skipped: channel ch-1 not in allowlist',
    );
  });

  it('empty output logs a warning', async () => {
    const { parseDiscordActions } = await import('./actions.js');
    (parseDiscordActions as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      actions: [],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const opts = makeOpts({
      runtime: makeRuntime([{ type: 'text_final', text: '' } as EngineEvent, { type: 'done' } as EngineEvent]),
      log,
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    expect(log.warn).toHaveBeenCalledWith(
      { flow: 'defer', channelId: 'ch-1' },
      'defer:empty output, nothing to send',
    );
  });

  it('spawn flag is included in deferred action flags when discordActionsSpawn is set', async () => {
    const { parseDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;
    mockParse.mockClear();
    mockParse.mockReturnValue({
      actions: [],
      cleanText: 'ok',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const opts = makeOpts({
      state: { ...makeState(), discordActionsSpawn: true },
    });
    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    const flags = mockParse.mock.calls[0][1];
    expect(flags.spawn).toBe(true);
  });

  it('spawn flag defaults to false when discordActionsSpawn is not set', async () => {
    const { parseDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;
    mockParse.mockClear();
    mockParse.mockReturnValue({
      actions: [],
      cleanText: 'ok',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const opts = makeOpts(); // no discordActionsSpawn in state
    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    const flags = mockParse.mock.calls[0][1];
    expect(flags.spawn).toBe(false);
  });

  it('spawnCtx is forwarded to executeDiscordActions subsystems', async () => {
    const { parseDiscordActions, executeDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;
    const mockExecute = executeDiscordActions as ReturnType<typeof vi.fn>;
    mockParse.mockClear();
    mockExecute.mockClear();

    mockParse.mockReturnValue({
      actions: [{ type: 'spawnAgent', channel: 'general', prompt: 'do it' }],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    mockExecute.mockResolvedValue([{ ok: true, summary: 'spawned' }]);

    const fakeSpawnCtx = { runtime: {}, model: 'fast' };
    const opts = makeOpts({
      state: { ...makeState(), discordActionsSpawn: true, spawnCtx: fakeSpawnCtx },
    });

    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    // Fourth argument to executeDiscordActions is the subsystem contexts
    const subs = mockExecute.mock.calls[0][3];
    expect(subs.spawnCtx).toBe(fakeSpawnCtx);
  });

  it('deferMaxDepth 1 allows first level but blocks second', async () => {
    const { parseDiscordActions } = await import('./actions.js');
    const mockParse = parseDiscordActions as ReturnType<typeof vi.fn>;

    // First level: deferDepth undefined → depth = 1, maxDepth = 1 → defer: false
    mockParse.mockClear();
    mockParse.mockReturnValue({
      actions: [],
      cleanText: 'ok',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });

    const opts = makeOpts({ deferMaxDepth: 1 });
    const scheduler = configureDeferredScheduler(opts);
    scheduler.schedule({ action: makeAction(), context: makeContext() as any });
    await vi.advanceTimersByTimeAsync(2000);

    // depth = 0 + 1 = 1, maxDepth = 1 → 1 < 1 is false → defer: false
    const flags = mockParse.mock.calls[0][1];
    expect(flags.defer).toBe(false);
  });
});
