import { describe, expect, it, vi } from 'vitest';
import { createMessageCreateHandler } from './discord.js';
import { MetricsRegistry } from './observability/metrics.js';

function makeQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
    size: vi.fn(() => 0),
  };
}

function makeMsg(content: string, authorId = '123') {
  return {
    author: { id: authorId, bot: false, displayName: 'User', username: 'user' },
    guildId: 'guild',
    channelId: 'chan',
    channel: { send: vi.fn(async () => ({})), isThread: () => false, name: 'general' },
    content,
    reply: vi.fn(async (_opts?: any) => ({ edit: vi.fn(async () => {}) })),
    id: 'msg1',
  };
}

function baseParams(metrics: MetricsRegistry, overrides: Partial<any> = {}) {
  return {
    allowUserIds: new Set(['123']),
    botDisplayName: 'TestBot',
    runtime: { invoke: vi.fn(async function* () { yield { type: 'text_final', text: 'ok' } as any; }) } as any,
    sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
    workspaceCwd: '/tmp',
    projectCwd: '/tmp',
    groupsDir: '/tmp',
    useGroupDirCwd: false,
    runtimeModel: 'opus',
    runtimeTools: ['Read', 'Edit'],
    runtimeTimeoutMs: 1000,
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: true,
    discordActionsEnabled: false,
    discordActionsChannels: true,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    discordActionsTasks: false,
    discordActionsBotProfile: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'haiku',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 5,
    summaryDataDir: '/tmp/summaries',
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: '/tmp/shortterm',
    shortTermMaxEntries: 20,
    shortTermMaxAgeMs: 21600000,
    shortTermInjectMaxChars: 1000,
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/durable',
    durableInjectMaxChars: 2000,
    durableMaxItems: 200,
    memoryCommandsEnabled: false,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 86400000,
    streamStallWarningMs: 0,
    healthCommandsEnabled: true,
    healthVerboseAllowlist: new Set<string>(),
    healthConfigSnapshot: {
      runtimeModel: 'opus',
      runtimeTimeoutMs: 1000,
      runtimeTools: ['Read', 'Edit'],
      useRuntimeSessions: true,
      toolAwareStreaming: false,
      maxConcurrentInvocations: 0,
      discordActionsEnabled: false,
      summaryEnabled: false,
      durableMemoryEnabled: false,
      messageHistoryBudget: 0,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      cronEnabled: false,
      tasksEnabled: false,
      tasksActive: false,
      tasksSyncFailureRetryEnabled: true,
      tasksSyncFailureRetryDelayMs: 30000,
      tasksSyncDeferredRetryDelayMs: 30000,
      requireChannelContext: false,
      autoIndexChannelContext: false,
    },
    metrics,
    ...overrides,
  };
}

describe('health command integration', () => {
  it('handles !health without invoking runtime', async () => {
    const metrics = new MetricsRegistry();
    const queue = makeQueue();
    const params = baseParams(metrics);
    const handler = createMessageCreateHandler(params as any, queue as any);
    const msg = makeMsg('!health');

    await handler(msg as any);

    expect(msg.reply).toHaveBeenCalledOnce();
    expect((params.runtime.invoke as any)).not.toHaveBeenCalled();
    const payload = (msg.reply as any).mock.calls[0]?.[0];
    expect(payload).toBeTruthy();
    expect(payload.content).toContain('TestBot Health');
  });

  it('falls back to basic for !health verbose when user is not in verbose allowlist', async () => {
    const metrics = new MetricsRegistry();
    const queue = makeQueue();
    const params = baseParams(metrics, {
      healthVerboseAllowlist: new Set(['999']),
    });
    const handler = createMessageCreateHandler(params as any, queue as any);
    const msg = makeMsg('!health verbose', '123');

    await handler(msg as any);

    const payload = (msg.reply as any).mock.calls[0]?.[0];
    expect(payload).toBeTruthy();
    expect(payload.content).not.toContain('Config (safe)');
  });

  it('handles !health tools with live effective tools output', async () => {
    const metrics = new MetricsRegistry();
    const queue = makeQueue();
    const params = baseParams(metrics, {
      runtimeTools: ['Read', 'Edit', 'WebSearch'],
    });
    const handler = createMessageCreateHandler(params as any, queue as any);
    const msg = makeMsg('!health tools');

    await handler(msg as any);

    expect(msg.reply).toHaveBeenCalledOnce();
    expect((params.runtime.invoke as any)).not.toHaveBeenCalled();
    const payload = (msg.reply as any).mock.calls[0]?.[0];
    expect(payload).toBeTruthy();
    expect(payload.content).toContain('TestBot Tools');
    expect(payload.content).toContain('Permission tier: env');
    expect(payload.content).toContain('Effective tools: Read, Edit, WebSearch');
  });
});
