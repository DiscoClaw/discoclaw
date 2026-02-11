import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';

vi.mock('./parser.js', () => {
  return { parseCronDefinition: vi.fn() };
});

// Mock ensureStatusMessage and detectCadence to avoid side effects.
vi.mock('./discord-sync.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    ensureStatusMessage: vi.fn(async () => 'status-msg-1'),
  };
});
vi.mock('./cadence.js', () => ({
  detectCadence: vi.fn(() => 'daily'),
}));

function makeClient(forum: any, botUserId = 'bot-user-1') {
  return {
    channels: { cache: { get: vi.fn().mockReturnValue(forum) } },
    on: vi.fn(),
    user: { id: botUserId },
  };
}

function makeThread(overrides?: Partial<any>) {
  return {
    id: 'thread-1',
    name: 'Job 1',
    archived: false,
    parentId: 'forum-1',
    fetchStarterMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    client: { user: { id: 'bot-user-1' } },
    ...overrides,
  };
}

function makeForum(threads: any[]) {
  const active = new Map<string, any>(threads.map((t) => [t.id, t]));
  return {
    id: 'forum-1',
    type: ChannelType.GuildForum,
    name: 'cron-forum',
    guildId: 'guild-1',
    threads: {
      fetchActive: vi.fn().mockResolvedValue({ threads: active }),
    },
  };
}

function makeScheduler() {
  return {
    register: vi.fn(),
    disable: vi.fn(),
    unregister: vi.fn(),
    getJob: vi.fn(),
  };
}

describe('initCronForum', () => {
  let initCronForum: typeof import('./forum-sync.js').initCronForum;
  let parseCronDefinition: typeof import('./parser.js').parseCronDefinition;

  beforeEach(async () => {
    // Dynamic import after mocks are registered.
    ({ initCronForum } = await import('./forum-sync.js'));
    ({ parseCronDefinition } = await import('./parser.js'));
    vi.mocked(parseCronDefinition).mockReset();
  });

  it('does not register when starter author is not allowlisted', async () => {
    const thread = makeThread();
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'every day at 7am post to #general say hello',
      author: { id: 'u-not-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(scheduler.register).not.toHaveBeenCalled();
    expect(scheduler.disable).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledOnce();
  });

  it('registers when starter author is the bot itself (cronCreate flow)', async () => {
    const thread = makeThread();
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: '**Schedule:** `0 7 * * *` (UTC)\n**Channel:** #general\n\nSay hello.',
      author: { id: 'bot-user-1' },
      react: vi.fn().mockResolvedValue(undefined),
    });

    const forum = makeForum([thread]);
    const client = makeClient(forum, 'bot-user-1');
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(scheduler.register).toHaveBeenCalledOnce();
    expect(scheduler.disable).not.toHaveBeenCalled();
  });

  it('disables and reports when parsing fails', async () => {
    const thread = makeThread();
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'nonsense',
      author: { id: 'u-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue(null);

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(scheduler.register).not.toHaveBeenCalled();
    expect(scheduler.disable).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledOnce();
  });

  it('registers when parsing succeeds and author is allowlisted', async () => {
    const thread = makeThread();
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'every day at 7am post to #general say hello',
      author: { id: 'u-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(scheduler.register).toHaveBeenCalledOnce();
    expect(scheduler.disable).not.toHaveBeenCalled();
  });

  it('disables and reports when schedule is invalid', async () => {
    const thread = makeThread();
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'bad schedule',
      author: { id: 'u-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      schedule: 'not a cron',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    scheduler.register.mockImplementation(() => {
      throw new Error('invalid schedule');
    });

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(scheduler.register).toHaveBeenCalledOnce();
    expect(scheduler.disable).toHaveBeenCalledOnce();
    expect(thread.send).toHaveBeenCalledOnce();
  });

	  it('passes cronId to scheduler.register when statsStore has record', async () => {
	    const thread = makeThread();
	    thread.fetchStarterMessage.mockResolvedValue({
	      id: 'm1',
	      content: 'every day at 7am post to #general say hello',
	      author: { id: 'u-allowed' },
	      react: vi.fn().mockResolvedValue(undefined),
	    });
	    // Ensure messages.fetch exists for cronId recovery scan.
	    thread.messages.fetch = vi.fn().mockResolvedValue(new Map());

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });

    const statsStore = {
      getRecordByThreadId: vi.fn().mockReturnValue({ cronId: 'cron-recovered' }),
      getRecord: vi.fn().mockReturnValue({ cronId: 'cron-recovered', threadId: 'thread-1', disabled: false }),
      upsertRecord: vi.fn(async () => ({})),
    };

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      statsStore: statsStore as any,
    });

    // Should pass the recovered cronId to register.
    expect(scheduler.register).toHaveBeenCalledWith(
      'thread-1', 'thread-1', 'guild-1', 'Job 1',
      expect.objectContaining({ schedule: '0 7 * * *' }),
      'cron-recovered',
    );
  });

	  it('restores disabled state from stats store', async () => {
	    const thread = makeThread();
	    thread.fetchStarterMessage.mockResolvedValue({
	      id: 'm1',
	      content: 'every day at 7am post to #general say hello',
	      author: { id: 'u-allowed' },
	      react: vi.fn().mockResolvedValue(undefined),
	    });
	    thread.messages.fetch = vi.fn().mockResolvedValue(new Map());

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });

    const statsStore = {
      getRecordByThreadId: vi.fn().mockReturnValue({ cronId: 'cron-disabled', disabled: true }),
      getRecord: vi.fn().mockReturnValue({ cronId: 'cron-disabled', threadId: 'thread-1', disabled: true }),
      upsertRecord: vi.fn(async () => ({})),
    };

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      statsStore: statsStore as any,
    });

    // Should disable the job because stats record says disabled: true.
    expect(scheduler.disable).toHaveBeenCalledWith('thread-1');
  });
});
