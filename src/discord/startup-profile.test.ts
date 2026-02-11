import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ActivityType, GatewayIntentBits } from 'discord.js';

// We test the startup logic by calling startDiscordBot with mocked Client.
// The module under test is src/discord.ts — we import startDiscordBot.

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => Buffer.from('fake-avatar')),
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({})),
    writeFile: vi.fn(async () => {}),
  },
}));

let mockClientInstance: any;

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => mockClientInstance),
  };
});

// Suppress bootstrap side-effects.
vi.mock('../discord/system-bootstrap.js', () => ({
  selectBootstrapGuild: () => null,
  ensureSystemScaffold: async () => null,
}));

import { startDiscordBot } from '../discord.js';
import type { BotParams } from '../discord.js';
import fs from 'node:fs/promises';

function makeMockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeMockClient(overrides: Partial<any> = {}) {
  const setPresence = vi.fn();
  const setAvatar = vi.fn();
  const setStatus = vi.fn();
  const setActivity = vi.fn();
  const user = { setPresence, setAvatar, setStatus, setActivity, id: 'bot-1' };

  const guilds = new Map<string, any>();
  const guildObj = {
    id: 'guild-1',
    members: {
      me: {
        nickname: null,
        user: { username: 'TestBot' },
        setNickname: vi.fn(async () => {}),
      },
      fetchMe: vi.fn(async () => guildObj.members.me),
    },
  };
  guilds.set('guild-1', guildObj);

  return {
    user,
    guilds: { cache: { values: () => guilds.values(), get: (id: string) => guilds.get(id) } },
    on: vi.fn().mockReturnThis(),
    once: vi.fn((event: string, cb: () => void) => { if (event === 'ready') cb(); }),
    login: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    channels: { cache: { get: vi.fn() } },
    ...overrides,
  };
}

function baseParams(overrides: Partial<BotParams> = {}): BotParams {
  return {
    token: 'test-token',
    allowUserIds: new Set(['123']),
    botDisplayName: 'TestBot',
    log: makeMockLog() as any,
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: true,
    runtime: { invoke: vi.fn() } as any,
    sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
    workspaceCwd: '/tmp/workspace',
    groupsDir: '/tmp/groups',
    useGroupDirCwd: false,
    runtimeModel: 'opus',
    runtimeTools: [],
    runtimeTimeoutMs: 1000,
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    discordActionsBeads: false,
    discordActionsBotProfile: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'haiku',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 5,
    summaryDataDir: '/tmp/summaries',
    summaryToDurableEnabled: false,
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/durable',
    durableInjectMaxChars: 2000,
    durableMaxItems: 200,
    memoryCommandsEnabled: false,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 86400000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClientInstance = makeMockClient();
});

// ---------------------------------------------------------------------------
// Presence tests
// ---------------------------------------------------------------------------

describe('startup presence', () => {
  it('setPresence called with correct payload when botStatus + botActivity set', async () => {
    await startDiscordBot(baseParams({
      botStatus: 'dnd',
      botActivity: 'with beads',
      botActivityType: 'Playing',
    }));
    expect(mockClientInstance.user.setPresence).toHaveBeenCalledWith({
      status: 'dnd',
      activities: [{ name: 'with beads', type: ActivityType.Playing }],
    });
  });

  it('Custom activity uses state field', async () => {
    await startDiscordBot(baseParams({
      botActivity: 'Thinking hard',
      botActivityType: 'Custom',
    }));
    expect(mockClientInstance.user.setPresence).toHaveBeenCalledWith({
      activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: 'Thinking hard' }],
    });
  });

  it('status-only sets presence without activities key', async () => {
    await startDiscordBot(baseParams({ botStatus: 'dnd' }));
    expect(mockClientInstance.user.setPresence).toHaveBeenCalledWith({ status: 'dnd' });
  });

  it('activity-only sets presence without status key', async () => {
    await startDiscordBot(baseParams({ botActivity: 'with beads', botActivityType: 'Playing' }));
    expect(mockClientInstance.user.setPresence).toHaveBeenCalledWith({
      activities: [{ name: 'with beads', type: ActivityType.Playing }],
    });
  });

  it('setPresence not called when neither botStatus nor botActivity set', async () => {
    await startDiscordBot(baseParams());
    expect(mockClientInstance.user.setPresence).not.toHaveBeenCalled();
  });

  it('presence failure logged as warning, startup continues', async () => {
    mockClientInstance.user.setPresence.mockImplementationOnce(() => { throw new Error('presence fail'); });
    const log = makeMockLog();
    const result = await startDiscordBot(baseParams({ botStatus: 'idle', log: log as any }));
    expect(result.client).toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'discord:presence failed to set');
  });
});

// ---------------------------------------------------------------------------
// Avatar tests
// ---------------------------------------------------------------------------

describe('startup avatar', () => {
  it('setAvatar called with URL string for https sources', async () => {
    await startDiscordBot(baseParams({ botAvatar: 'https://example.com/avatar.png' }));
    expect(mockClientInstance.user.setAvatar).toHaveBeenCalledWith('https://example.com/avatar.png');
  });

  it('setAvatar called with URL string for http sources', async () => {
    await startDiscordBot(baseParams({ botAvatar: 'http://example.com/avatar.png' }));
    expect(mockClientInstance.user.setAvatar).toHaveBeenCalledWith('http://example.com/avatar.png');
  });

  it('setAvatar called with Buffer for file path sources', async () => {
    await startDiscordBot(baseParams({ botAvatar: '/home/user/avatar.png' }));
    expect(fs.readFile).toHaveBeenCalledWith('/home/user/avatar.png');
    expect(mockClientInstance.user.setAvatar).toHaveBeenCalledWith(Buffer.from('fake-avatar'));
  });

  it('avatar failure logged as warning, startup continues', async () => {
    mockClientInstance.user.setAvatar.mockRejectedValueOnce(new Error('rate limited'));
    const log = makeMockLog();
    const result = await startDiscordBot(baseParams({ botAvatar: 'https://example.com/avatar.png', log: log as any }));
    expect(result.client).toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), avatar: 'https://example.com/avatar.png' }),
      'discord:avatar failed to set',
    );
  });
});

// ---------------------------------------------------------------------------
// Reaction remove handler wiring tests
// ---------------------------------------------------------------------------

describe('reaction remove handler wiring', () => {
  it('registers messageReactionRemove listener when reactionRemoveHandlerEnabled is true', async () => {
    await startDiscordBot(baseParams({ reactionRemoveHandlerEnabled: true }));
    const onCalls = mockClientInstance.on.mock.calls;
    const events = onCalls.map((c: any[]) => c[0]);
    expect(events).toContain('messageReactionRemove');
  });

  it('does NOT register messageReactionRemove listener when reactionRemoveHandlerEnabled is false', async () => {
    await startDiscordBot(baseParams({ reactionRemoveHandlerEnabled: false }));
    const onCalls = mockClientInstance.on.mock.calls;
    const events = onCalls.map((c: any[]) => c[0]);
    expect(events).not.toContain('messageReactionRemove');
  });

  it('enables GuildMessageReactions intent when only remove handler is enabled (add disabled)', async () => {
    const { Client } = await import('discord.js');
    await startDiscordBot(baseParams({ reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: true }));
    const constructorCall = (Client as any).mock.calls.at(-1)[0];
    expect(constructorCall.intents).toContain(GatewayIntentBits.GuildMessageReactions);
  });
});
