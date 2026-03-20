import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageCreateHandler } from './discord.js';
import { MetricsRegistry } from './observability/metrics.js';

const browserMocks = vi.hoisted(() => ({
  handleBrowserCommand: vi.fn(async (command: { action: string; headless?: boolean }) => {
    if (command.action === 'launch' && command.headless) {
      return 'browser-response:launch:headless';
    }
    return `browser-response:${command.action}`;
  }),
  renderBrowserHelp: vi.fn(() => 'mock browser help'),
}));

vi.mock('./discord/browser-command.js', async () => {
  const actual = await vi.importActual<typeof import('./discord/browser-command.js')>('./discord/browser-command.js');
  return {
    ...actual,
    handleBrowserCommand: browserMocks.handleBrowserCommand,
    renderBrowserHelp: browserMocks.renderBrowserHelp,
  };
});

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
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
    botDisplayName: 'TestBot',
    runtime: { invoke: vi.fn(async function* () { yield { type: 'text_final', text: 'ok' } as any; }) } as any,
    sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
    workspaceCwd: '/tmp',
    projectCwd: '/tmp/project',
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
    healthCommandsEnabled: false,
    metrics,
    ...overrides,
  };
}

describe('browser command integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['!browser', { action: 'help' }, 'browser-response:help'],
    ['!browser setup', { action: 'setup' }, 'browser-response:setup'],
    ['!browser doctor', { action: 'doctor' }, 'browser-response:doctor'],
    ['!browser launch', { action: 'launch', headless: false }, 'browser-response:launch'],
    ['!browser launch --headless', { action: 'launch', headless: true }, 'browser-response:launch:headless'],
  ])('handles %s without invoking runtime', async (content, expectedCommand, expectedReply) => {
    const metrics = new MetricsRegistry();
    const queue = makeQueue();
    const params = baseParams(metrics);
    const handler = createMessageCreateHandler(params as any, queue as any);
    const msg = makeMsg(content);

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect((params.runtime.invoke as any)).not.toHaveBeenCalled();
    expect(browserMocks.handleBrowserCommand).toHaveBeenCalledOnce();
    expect(browserMocks.handleBrowserCommand).toHaveBeenCalledWith(
      expectedCommand,
      { cwd: '/tmp/project', env: process.env },
    );
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expectedReply,
    }));
  });

  it('rejects unsupported !browser subcommands without invoking runtime', async () => {
    const metrics = new MetricsRegistry();
    const queue = makeQueue();
    const params = baseParams(metrics);
    const handler = createMessageCreateHandler(params as any, queue as any);
    const msg = makeMsg('!browser reload');

    await handler(msg as any);

    expect(queue.run).not.toHaveBeenCalled();
    expect((params.runtime.invoke as any)).not.toHaveBeenCalled();
    expect(browserMocks.handleBrowserCommand).not.toHaveBeenCalled();
    expect(browserMocks.renderBrowserHelp).toHaveBeenCalledOnce();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Unknown `!browser` subcommand.\n\nmock browser help',
    }));
  });
});
