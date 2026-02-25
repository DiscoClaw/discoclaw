import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageCreateHandler } from './message-coordinator.js';
import { completeOnboarding } from './onboarding-completion.js';
import { getDefaultTimezone } from '../cron/default-timezone.js';

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => false),
}));

vi.mock('./onboarding-completion.js', () => ({
  completeOnboarding: vi.fn(async () => ({
    writeResult: { written: ['IDENTITY.md', 'USER.md'], errors: [], warnings: [] },
  })),
}));

vi.mock('../cron/default-timezone.js', () => ({
  getDefaultTimezone: vi.fn(() => 'Etc/Test'),
}));

function makeParams(workspaceCwd: string) {
  const metrics = { increment: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    allowUserIds: new Set(['user-1']),
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
    dataDir: workspaceCwd,
    botDisplayName: 'Discoclaw',
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: false,
    runtime: { id: 'claude', capabilities: {} },
    sessionManager: {} as any,
    workspaceCwd,
    projectCwd: workspaceCwd,
    groupsDir: workspaceCwd,
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
    summaryDataDir: workspaceCwd,
    durableMemoryEnabled: false,
    durableDataDir: workspaceCwd,
    durableInjectMaxChars: 2000,
    durableMaxItems: 100,
    memoryCommandsEnabled: false,
    planCommandsEnabled: false,
    forgeCommandsEnabled: false,
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: workspaceCwd,
    shortTermMaxEntries: 0,
    shortTermMaxAgeMs: 0,
    shortTermInjectMaxChars: 0,
    streamStallWarningMs: 10_000,
    actionFollowupDepth: 1,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 0,
    healthCommandsEnabled: false,
    metrics,
    log,
  } as any;
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  const author = {
    id: 'user-1',
    bot: false,
    displayName: 'Alice',
    username: 'alice',
    send: vi.fn(async () => ({})),
  };
  const channel = {
    id: 'dm-1',
    name: 'dm',
    send: vi.fn(async () => ({})),
    isThread: () => false,
  };
  const msg = {
    id: 'm1',
    type: 0,
    content: 'hello',
    author,
    guildId: null,
    guild: null,
    channelId: 'dm-1',
    channel,
    client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    reply: vi.fn(async () => ({})),
  };
  return Object.assign(msg, overrides);
}

describe('message coordinator onboarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-21T08:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes onboarding with defaults when an active session is timed out', async () => {
    const workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-onboard-timeout-'));
    await fs.writeFile(path.join(workspaceCwd, 'IDENTITY.md'), 'template marker', 'utf8');

    const params = makeParams(workspaceCwd);
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(params, queue as any);

    const startMsg = makeMessage();
    await handler(startMsg);

    vi.setSystemTime(new Date('2026-02-22T08:00:01.000Z'));
    const timedOutMsg = makeMessage({
      id: 'm2',
      author: startMsg.author,
      channel: startMsg.channel,
      content: 'still here',
    });
    await handler(timedOutMsg);

    expect(queue.run).not.toHaveBeenCalled();
    expect(vi.mocked(getDefaultTimezone)).toHaveBeenCalled();
    expect(vi.mocked(completeOnboarding)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeOnboarding)).toHaveBeenCalledWith(
      { userName: 'Alice', timezone: 'Etc/Test', morningCheckin: false },
      workspaceCwd,
      startMsg.author,
      undefined,
    );
  });

  it('sends redirect once for wrong-channel onboarding messages and then passes through', async () => {
    const workspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-onboard-redirect-'));
    await fs.writeFile(path.join(workspaceCwd, 'IDENTITY.md'), 'template marker', 'utf8');

    const params = makeParams(workspaceCwd);
    const queue = { run: vi.fn(async () => undefined) };
    const handler = createMessageCreateHandler(params, queue as any);

    const startMsg = makeMessage();
    await handler(startMsg);

    const wrongChannelMsg1 = makeMessage({
      id: 'm2',
      author: startMsg.author,
      content: 'hello from guild',
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      channelId: 'guild-channel-1',
      channel: {
        id: 'guild-channel-1',
        name: 'general',
        send: vi.fn(async () => ({})),
        isThread: () => false,
      },
    });
    await handler(wrongChannelMsg1);

    expect(wrongChannelMsg1.reply).toHaveBeenCalledTimes(1);
    expect(wrongChannelMsg1.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('setting things up with you in DMs'),
    }));
    expect(queue.run).toHaveBeenCalledTimes(1);

    const wrongChannelMsg2 = makeMessage({
      id: 'm3',
      author: startMsg.author,
      content: 'another guild message',
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      channelId: 'guild-channel-2',
      channel: {
        id: 'guild-channel-2',
        name: 'general-2',
        send: vi.fn(async () => ({})),
        isThread: () => false,
      },
    });
    await handler(wrongChannelMsg2);

    expect(wrongChannelMsg2.reply).not.toHaveBeenCalled();
    expect(queue.run).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeOnboarding)).not.toHaveBeenCalled();
  });
});
