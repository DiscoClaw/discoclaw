/**
 * Regression test: 🛑 reaction must be removed BEFORE discord actions execute.
 *
 * Bug scenario: AI response includes a taskClose action → executeDiscordActions
 * archives the thread → reaction removal in the finally block fails silently
 * because Discord rejects edits/reactions on archived threads.
 *
 * The fix: eager removal of 🛑 immediately after stream completion, before
 * action execution.  This test verifies that ordering invariant.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { _resetForTest as resetAbortRegistry } from './abort-registry.js';
import { _resetForTest as resetInflightReplies } from './inflight-replies.js';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

const executeDiscordActionsMock = vi.fn(async () => [
  { ok: true, summary: 'Task closed' },
]);

vi.mock('./actions.js', () => ({
  parseDiscordActions: vi.fn((_text: string) => ({
    actions: [{ type: 'taskClose', taskId: 'ws-001', reason: 'Done' }],
    cleanText: 'Closing the task.',
    strippedUnrecognizedTypes: [],
    parseFailures: 0,
  })),
  executeDiscordActions: executeDiscordActionsMock,
  discordActionsPromptSection: vi.fn(() => ''),
  buildDisplayResultLines: vi.fn(() => ['Task closed']),
  buildAllResultLines: vi.fn(() => ['Task closed']),
  appendActionResults: vi.fn((body: string) => body + '\n> Task closed'),
}));

vi.mock('./transport-client.js', () => ({
  DiscordTransportClient: vi.fn(() => ({})),
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
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
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
    discordActionsEnabled: true,
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
    actionFollowupDepth: 0,
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

function makeReplyMock() {
  const removeStopReaction = vi.fn(async () => undefined);
  const reply = {
    id: 'reply-1',
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    react: vi.fn(() => Promise.resolve({ remove: removeStopReaction })),
    reactions: {
      resolve: vi.fn((emoji: string) =>
        emoji === '🛑' ? { remove: removeStopReaction } : null,
      ),
    },
  };
  return { reply, removeStopReaction };
}

/** Message with guild context — required for action execution path. */
function makeGuildMessage(reply: any) {
  return {
    id: 'm1',
    type: 0,
    content: 'Close the task',
    author: { id: 'user-1', bot: false },
    guildId: 'guild-1',
    guild: { id: 'guild-1' },
    channelId: 'ch-1',
    channel: {
      id: 'ch-1',
      name: 'general',
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

describe('🛑 removal happens before action execution (taskClose regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('removes 🛑 before executeDiscordActions runs', async () => {
    const order: string[] = [];

    const { reply, removeStopReaction } = makeReplyMock();
    removeStopReaction.mockImplementation(async () => { order.push('stop-reaction-removed'); });
    executeDiscordActionsMock.mockImplementation(async () => {
      order.push('actions-executed');
      return [{ ok: true, summary: 'Task closed' }];
    });

    const msg = makeGuildMessage(reply);
    const runtime = makeRuntime([
      // Response text includes a discord-action block — parseDiscordActions (mocked)
      // will return a taskClose action regardless of text content.
      { type: 'text_final', text: 'Closing the task.\n<discord-action>{"type":"taskClose","taskId":"ws-001","reason":"Done"}</discord-action>' },
      { type: 'done' },
    ]);

    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // Core invariant: stop reaction removed before actions execute.
    expect(removeStopReaction).toHaveBeenCalledTimes(1);
    expect(executeDiscordActionsMock).toHaveBeenCalledTimes(1);

    const removeIdx = order.indexOf('stop-reaction-removed');
    const actionsIdx = order.indexOf('actions-executed');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(actionsIdx).toBeGreaterThan(removeIdx);
  });
});
