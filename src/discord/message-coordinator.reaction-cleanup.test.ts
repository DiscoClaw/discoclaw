import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { _resetForTest as resetAbortRegistry } from './abort-registry.js';
import { _resetForTest as resetInflightReplies } from './inflight-replies.js';

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(events: EngineEvent[]) {
  return {
    id: 'test',
    capabilities: {},
    async *invoke(): AsyncIterable<EngineEvent> {
      for (const evt of events) yield evt;
    },
  };
}

function makeParams(runtime: any) {
  return {
    allowUserIds: new Set(['user-1']),
    botDisplayName: 'Discoclaw',
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: false,
    runtime,
    sessionManager: {} as any,
    workspaceCwd: '/tmp/workspace',
    projectCwd: '/tmp/workspace',
    groupsDir: '/tmp/workspace',
    useGroupDirCwd: false,
    runtimeModel: 'capable',
    runtimeTools: [],
    runtimeTimeoutMs: 30_000,
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'fast',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 6,
    summaryDataDir: '/tmp/workspace',
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/workspace',
    durableInjectMaxChars: 2000,
    durableMaxItems: 100,
    memoryCommandsEnabled: false,
    planCommandsEnabled: false,
    forgeCommandsEnabled: false,
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: '/tmp/workspace',
    shortTermMaxEntries: 0,
    shortTermMaxAgeMs: 0,
    shortTermInjectMaxChars: 0,
    streamStallWarningMs: 10_000,
    actionFollowupDepth: 1,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 0,
    healthCommandsEnabled: false,
    metrics: {
      increment: vi.fn(),
      recordInvokeStart: vi.fn(),
      recordInvokeResult: vi.fn(),
      recordActionResult: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
}

/** Build a reply mock and expose the stop-reaction remove spy directly. */
function makeReplyMock(reactImpl?: () => Promise<unknown>) {
  const removeStopReaction = vi.fn(async () => undefined);
  const reply = {
    id: 'reply-1',
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    react: vi.fn(reactImpl ?? (() => Promise.resolve(undefined))),
    reactions: {
      resolve: vi.fn((emoji: string) =>
        emoji === '🛑' ? { remove: removeStopReaction } : null,
      ),
    },
  };
  return { reply, removeStopReaction };
}

function makeMessage(reply: any) {
  return {
    id: 'm1',
    type: 0,
    content: 'hello',
    author: { id: 'user-1', bot: false },
    guildId: null,
    guild: null,
    channelId: 'ch-1',
    channel: {
      id: 'ch-1',
      name: 'dm',
      send: vi.fn().mockResolvedValue({}),
      isThread: () => false,
    },
    client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    reply: vi.fn().mockResolvedValue(reply),
  };
}

async function makeHandler(params: any, queue: any) {
  const { createMessageCreateHandler } = await import('./message-coordinator.js');
  return createMessageCreateHandler(params, queue);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('🛑 reaction cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('removes 🛑 after a successful stream', async () => {
    const { reply, removeStopReaction } = makeReplyMock();
    const msg = makeMessage(reply);
    const runtime = makeRuntime([
      { type: 'text_final', text: 'Done.' },
      { type: 'done' },
    ]);

    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(reply.react).toHaveBeenCalledWith('🛑');
    expect(removeStopReaction).toHaveBeenCalledTimes(1);
  });

  it('removes 🛑 when the stream errors immediately', async () => {
    const { reply, removeStopReaction } = makeReplyMock();
    const msg = makeMessage(reply);
    const runtime = makeRuntime([
      { type: 'error', message: 'generateImage: 404 Not Found' },
      { type: 'done' },
    ]);

    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(reply.react).toHaveBeenCalledWith('🛑');
    expect(removeStopReaction).toHaveBeenCalledTimes(1);
  });

  it('removes 🛑 even when react() itself rejects', async () => {
    const { reply, removeStopReaction } = makeReplyMock(
      () => Promise.reject(new Error('rate limited')),
    );
    const msg = makeMessage(reply);
    const runtime = makeRuntime([
      { type: 'error', message: 'image generation failed' },
      { type: 'done' },
    ]);

    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await expect(handler(msg as any)).resolves.not.toThrow();
    expect(removeStopReaction).toHaveBeenCalledTimes(1);
  });

  it('awaits react() before calling remove — ordering guarantee for fast-fail streams', async () => {
    const order: string[] = [];

    // Controlled react promise: doesn't resolve until we call resolveReact().
    let resolveReact!: () => void;
    const slowReact = new Promise<void>((res) => { resolveReact = res; });

    // Track order: react-resolved fires when the slow promise resolves.
    void slowReact.then(() => { order.push('react-resolved'); });

    const { reply, removeStopReaction } = makeReplyMock(() => slowReact);
    removeStopReaction.mockImplementation(async () => { order.push('remove'); });

    const msg = makeMessage(reply);
    const runtime = makeRuntime([
      // Immediate failure — simulates a fast-failing generateImage 404.
      { type: 'error', message: 'generateImage: 404' },
      { type: 'done' },
    ]);

    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    // Start the handler but don't await — the finally block will block on reactPromise.
    const handlerPromise = handler(msg as any);

    // Wait until react('🛑') has been called (happens synchronously before the inner try).
    await vi.waitFor(() => expect(reply.react).toHaveBeenCalledWith('🛑'));

    // The stream has already errored and the finally block is awaiting reactPromise.
    // remove() must NOT have been called yet — that's the race condition we're fixing.
    expect(removeStopReaction).not.toHaveBeenCalled();

    // Unblock the react() promise — simulates the Discord API round-trip completing.
    resolveReact();
    await handlerPromise;

    // remove() must have been called, and only after react resolved.
    expect(removeStopReaction).toHaveBeenCalledTimes(1);
    const reactIdx = order.indexOf('react-resolved');
    const removeIdx = order.indexOf('remove');
    expect(reactIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(reactIdx);
  });
});
