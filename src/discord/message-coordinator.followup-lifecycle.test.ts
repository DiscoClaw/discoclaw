import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { _resetForTest as resetAbortRegistry } from './abort-registry.js';
import { _resetForTest as resetInflightReplies } from './inflight-replies.js';

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

vi.mock('./actions.js', () => ({
  parseDiscordActions: vi.fn((text: string) => text.includes('<discord-action>')
    ? {
      actions: [{ type: 'channelList' }],
      cleanText: 'Channel lookup complete.',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    }
    : {
      actions: [],
      cleanText: text,
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    }),
  executeDiscordActions: vi.fn(async () => [{ ok: true, summary: 'general, random' }]),
  buildTieredDiscordActionsPromptSection: vi.fn(() => ({
    prompt: '',
    includedCategories: [],
    tierBuckets: { core: [], channelContextual: [], keywordTriggered: [] },
    keywordHits: [],
  })),
  buildDisplayResultLines: vi.fn(() => ['Succeeded: general, random']),
  buildAllResultLines: vi.fn(() => ['Succeeded: general, random']),
  buildCappedResultLines: vi.fn(() => ['Succeeded: general, random']),
  appendActionResults: vi.fn((body: string) => `${body}\n> general, random`),
  withoutRequesterGatedActionFlags: vi.fn((flags: unknown) => flags),
}));

vi.mock('./transport-client.js', () => ({
  DiscordTransportClient: vi.fn(() => ({})),
}));

function makeRuntimeWithFollowUpText(order: string[], followUpText: string) {
  let callCount = 0;
  return {
    id: 'test',
    capabilities: new Set<string>(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      callCount += 1;
      order.push(`invoke:${callCount}`);
      if (callCount === 1) {
        yield {
          type: 'text_final',
          text: 'Looking up channels.\n<discord-action>{"type":"channelList"}</discord-action>',
        };
      } else {
        yield { type: 'text_final', text: followUpText };
      }
      yield { type: 'done' };
    },
  };
}

function makeRuntime(order: string[]) {
  return makeRuntimeWithFollowUpText(order, 'The channel list is ready.');
}

function makeLongFollowUpRuntime(order: string[]) {
  const longBody = `Follow-up body ${'x'.repeat(2400)}`;
  return makeRuntimeWithFollowUpText(order, longBody);
}

function makeReply(id: string) {
  return {
    id,
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  };
}

function makeParams(runtime: any, watchdog: any) {
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
    discordActionsChannels: true,
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
    longRunWatchdog: watchdog,
    longRunStillRunningDelayMs: 1_000,
  } as any;
}

describe('message auto-follow-up lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('renders pending before posting the placeholder and starts the watchdog before the follow-up invoke', async () => {
    const order: string[] = [];
    const initialReply = makeReply('initial-reply');
    const followUpReply = makeReply('follow-up-reply');
    const runtime = makeRuntime(order);
    const watchdog = {
      start: vi.fn(async (input: { messageId: string }) => {
        order.push(`watchdog-start:${input.messageId}`);
        return { deduped: false, run: {} };
      }),
      stageRecovery: vi.fn(async () => null),
      complete: vi.fn(async () => ({
        runId: 'run-1',
        channelId: 'ch-1',
        messageId: 'follow-up-reply',
        sessionKey: 'session-1',
        runKind: 'discord-action-followup',
        correlationToken: 'ignored',
        notifyOnCompletion: false,
        status: 'completed',
        startedAt: 0,
        checkInDueAt: 0,
        checkInPosted: false,
        checkInPostedAt: null,
        recoveryText: null,
        completion: 'succeeded',
        completionDetail: null,
        completedAt: 0,
        deliveryConfirmed: false,
        finalPosted: false,
        finalPostAttempts: 0,
        lastFinalAttemptAt: null,
        finalError: null,
        updatedAt: 0,
      })),
      startupSweep: vi.fn(async () => ({ interruptedRuns: 0, finalRetried: 0, finalPosted: 0, finalFailed: 0 })),
    };
    const channelSend = vi.fn(async (opts: { content: string }) => {
      order.push(`placeholder:${opts.content}`);
      return followUpReply;
    });
    const msg = {
      id: 'm1',
      type: 0,
      content: 'hello',
      author: { id: 'user-1', bot: false },
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      channelId: 'ch-1',
      channel: {
        id: 'ch-1',
        name: 'general',
        send: channelSend,
        isThread: () => false,
      },
      client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      mentions: { has: () => false },
      reply: vi.fn().mockResolvedValue(initialReply),
    };

    const { createMessageCreateHandler } = await import('./message-coordinator.js');
    const handler = createMessageCreateHandler(makeParams(runtime, watchdog), {
      run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
    } as any);

    await handler(msg as any);

    const placeholderContent = channelSend.mock.calls[0]?.[0]?.content as string;
    expect(placeholderContent).toContain('Auto-follow-up');
    const token = placeholderContent.match(/`([^`]+)`/)?.[1];
    expect(token).toBeTruthy();
    expect(order.indexOf(`placeholder:${placeholderContent}`)).toBeLessThan(order.indexOf('watchdog-start:follow-up-reply'));
    expect(order.indexOf('watchdog-start:follow-up-reply')).toBeLessThan(order.indexOf('invoke:2'));
    expect(initialReply.edit.mock.calls.some((call) => String(call[0]?.content ?? '').includes(`Auto-follow-up \`${token}\`: pending.`))).toBe(true);
    expect(followUpReply.edit.mock.calls.some((call) => String(call[0]?.content ?? '').includes(`Auto-follow-up \`${token}\`: completed.`))).toBe(true);
  });

  it('keeps terminal lifecycle on the placeholder when a follow-up reply is chunked', async () => {
    const order: string[] = [];
    const initialReply = makeReply('initial-reply');
    const followUpReply = makeReply('follow-up-reply');
    const runtime = makeLongFollowUpRuntime(order);
    const watchdog = {
      start: vi.fn(async (input: { messageId: string }) => {
        order.push(`watchdog-start:${input.messageId}`);
        return { deduped: false, run: {} };
      }),
      stageRecovery: vi.fn(async () => null),
      complete: vi.fn(async () => ({
        runId: 'run-1',
        channelId: 'ch-1',
        messageId: 'follow-up-reply',
        sessionKey: 'session-1',
        runKind: 'discord-action-followup',
        correlationToken: 'ignored',
        notifyOnCompletion: false,
        status: 'completed',
        startedAt: 0,
        checkInDueAt: 0,
        checkInPosted: false,
        checkInPostedAt: null,
        recoveryText: null,
        completion: 'succeeded',
        completionDetail: null,
        completedAt: 0,
        deliveryConfirmed: false,
        finalPosted: false,
        finalPostAttempts: 0,
        lastFinalAttemptAt: null,
        finalError: null,
        updatedAt: 0,
      })),
      startupSweep: vi.fn(async () => ({ interruptedRuns: 0, finalRetried: 0, finalPosted: 0, finalFailed: 0 })),
    };
    const channelSend = vi.fn(async (_opts: { content: string }) => {
      if (channelSend.mock.calls.length === 1) {
        return followUpReply;
      }
      return undefined;
    });
    const msg = {
      id: 'm1',
      type: 0,
      content: 'hello',
      author: { id: 'user-1', bot: false },
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      channelId: 'ch-1',
      channel: {
        id: 'ch-1',
        name: 'general',
        send: channelSend,
        isThread: () => false,
      },
      client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      mentions: { has: () => false },
      reply: vi.fn().mockResolvedValue(initialReply),
    };

    const { createMessageCreateHandler } = await import('./message-coordinator.js');
    const handler = createMessageCreateHandler(makeParams(runtime, watchdog), {
      run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
    } as any);

    await handler(msg as any);

    const placeholderCall = channelSend.mock.calls[0]?.[0] as { content: string } | undefined;
    const placeholderContent = placeholderCall?.content ?? '';
    const token = placeholderContent.match(/`([^`]+)`/)?.[1];
    expect(token).toBeTruthy();
    expect(followUpReply.edit.mock.calls.some((call) => {
      const content = String(call[0]?.content ?? '');
      return content.includes(`Auto-follow-up \`${token}\`: completed.`)
        && content.includes('Follow-up body');
    })).toBe(true);
    expect(channelSend.mock.calls.length).toBeGreaterThan(1);
    const bodyCall = channelSend.mock.calls[1]?.[0] as { content?: string } | undefined;
    expect(String(bodyCall?.content ?? '')).toContain('xxxxxxxx');
  });

  it('keeps a completed lifecycle line on the placeholder for lifecycle-only follow-up turns', async () => {
    const order: string[] = [];
    const initialReply = makeReply('initial-reply');
    const followUpReply = makeReply('follow-up-reply');
    const runtime = makeRuntimeWithFollowUpText(
      order,
      '<discord-action>{"type":"channelList"}</discord-action>',
    );
    const actionsMod = await import('./actions.js');
    vi.mocked(actionsMod.parseDiscordActions)
      .mockReturnValueOnce({
        actions: [{ type: 'channelList' }],
        cleanText: 'Looking up channels.',
        strippedUnrecognizedTypes: [],
        parseFailures: 0,
      })
      .mockReturnValueOnce({
        actions: [{ type: 'channelList' }],
        cleanText: '',
        strippedUnrecognizedTypes: [],
        parseFailures: 0,
      });
    vi.mocked(actionsMod.appendActionResults)
      .mockImplementationOnce((body: string) => body)
      .mockImplementationOnce((body: string) => body);
    const watchdog = {
      start: vi.fn(async (input: { messageId: string }) => {
        order.push(`watchdog-start:${input.messageId}`);
        return { deduped: false, run: {} };
      }),
      stageRecovery: vi.fn(async () => null),
      complete: vi.fn(async () => ({
        runId: 'run-1',
        channelId: 'ch-1',
        messageId: 'follow-up-reply',
        sessionKey: 'session-1',
        runKind: 'discord-action-followup',
        correlationToken: 'ignored',
        notifyOnCompletion: false,
        status: 'completed',
        startedAt: 0,
        checkInDueAt: 0,
        checkInPosted: false,
        checkInPostedAt: null,
        recoveryText: null,
        completion: 'succeeded',
        completionDetail: null,
        completedAt: 0,
        deliveryConfirmed: false,
        finalPosted: false,
        finalPostAttempts: 0,
        lastFinalAttemptAt: null,
        finalError: null,
        updatedAt: 0,
      })),
      startupSweep: vi.fn(async () => ({ interruptedRuns: 0, finalRetried: 0, finalPosted: 0, finalFailed: 0 })),
    };
    const channelSend = vi.fn(async (_opts: { content: string }) => followUpReply);
    const msg = {
      id: 'm1',
      type: 0,
      content: 'hello',
      author: { id: 'user-1', bot: false },
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      channelId: 'ch-1',
      channel: {
        id: 'ch-1',
        name: 'general',
        send: channelSend,
        isThread: () => false,
      },
      client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      mentions: { has: () => false },
      reply: vi.fn().mockResolvedValue(initialReply),
    };

    const { createMessageCreateHandler } = await import('./message-coordinator.js');
    const handler = createMessageCreateHandler(makeParams(runtime, watchdog), {
      run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
    } as any);

    await handler(msg as any);

    const placeholderContent = channelSend.mock.calls[0]?.[0]?.content as string;
    const token = placeholderContent.match(/`([^`]+)`/)?.[1];
    expect(token).toBeTruthy();
    expect(followUpReply.edit).toHaveBeenLastCalledWith({
      content: `Auto-follow-up \`${token}\`: completed.`,
      allowedMentions: { parse: [] },
    });
    expect(followUpReply.delete).not.toHaveBeenCalled();
    expect(watchdog.stageRecovery).toHaveBeenLastCalledWith(
      expect.any(String),
      { text: `Auto-follow-up \`${token}\`: completed.` },
    );
  });

  it('keeps a completed lifecycle line on the placeholder when a short follow-up is suppressed', async () => {
    const order: string[] = [];
    const initialReply = makeReply('initial-reply');
    const followUpReply = makeReply('follow-up-reply');
    const runtime = makeRuntimeWithFollowUpText(order, 'Done.');
    const watchdog = {
      start: vi.fn(async (input: { messageId: string }) => {
        order.push(`watchdog-start:${input.messageId}`);
        return { deduped: false, run: {} };
      }),
      stageRecovery: vi.fn(async () => null),
      complete: vi.fn(async () => ({
        runId: 'run-1',
        channelId: 'ch-1',
        messageId: 'follow-up-reply',
        sessionKey: 'session-1',
        runKind: 'discord-action-followup',
        correlationToken: 'ignored',
        notifyOnCompletion: false,
        status: 'completed',
        startedAt: 0,
        checkInDueAt: 0,
        checkInPosted: false,
        checkInPostedAt: null,
        recoveryText: null,
        completion: 'succeeded',
        completionDetail: null,
        completedAt: 0,
        deliveryConfirmed: false,
        finalPosted: false,
        finalPostAttempts: 0,
        lastFinalAttemptAt: null,
        finalError: null,
        updatedAt: 0,
      })),
      startupSweep: vi.fn(async () => ({ interruptedRuns: 0, finalRetried: 0, finalPosted: 0, finalFailed: 0 })),
    };
    const channelSend = vi.fn(async (_opts: { content: string }) => followUpReply);
    const msg = {
      id: 'm1',
      type: 0,
      content: 'hello',
      author: { id: 'user-1', bot: false },
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      channelId: 'ch-1',
      channel: {
        id: 'ch-1',
        name: 'general',
        send: channelSend,
        isThread: () => false,
      },
      client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      mentions: { has: () => false },
      reply: vi.fn().mockResolvedValue(initialReply),
    };

    const { createMessageCreateHandler } = await import('./message-coordinator.js');
    const handler = createMessageCreateHandler(makeParams(runtime, watchdog), {
      run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()),
    } as any);

    await handler(msg as any);

    const placeholderContent = channelSend.mock.calls[0]?.[0]?.content as string;
    const token = placeholderContent.match(/`([^`]+)`/)?.[1];
    expect(token).toBeTruthy();
    expect(followUpReply.edit).toHaveBeenLastCalledWith({
      content: `Auto-follow-up \`${token}\`: completed.`,
      allowedMentions: { parse: [] },
    });
    expect(followUpReply.delete).not.toHaveBeenCalled();
    expect(watchdog.stageRecovery).toHaveBeenLastCalledWith(
      expect.any(String),
      { text: `Auto-follow-up \`${token}\`: completed.` },
    );
  });
});
