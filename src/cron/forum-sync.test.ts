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
  const listeners: Record<string, Function[]> = {};
  return {
    channels: { cache: { get: vi.fn().mockReturnValue(forum) } },
    on: vi.fn((event: string, cb: Function) => {
      (listeners[event] ??= []).push(cb);
    }),
    user: { id: botUserId },
    _listeners: listeners,
  };
}

function makeThread(overrides?: Partial<any>) {
  return {
    id: 'thread-1',
    name: 'Job 1',
    archived: false,
    parentId: 'forum-1',
    ownerId: 'bot-user-1',
    fetchStarterMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
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
      triggerType: 'schedule',
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
      triggerType: 'schedule',
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
      triggerType: 'schedule',
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
      triggerType: 'schedule',
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
      triggerType: 'schedule',
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

  it('recovers cronId from statusMessageId metadata before content token parsing', async () => {
    const thread = makeThread();
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'every day at 7am post to #general say hello',
      author: { id: 'u-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });
    const statusMsg = { id: 'status-msg-123', author: { bot: true }, content: '📊 **Cron Status** no token' };
    thread.messages.fetch = vi.fn().mockResolvedValue(new Map([[statusMsg.id, statusMsg]]));

    const forum = makeForum([thread]);
    const client = makeClient(forum);
    const scheduler = makeScheduler();

    vi.mocked(parseCronDefinition).mockResolvedValue({
      triggerType: 'schedule',
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });

    const statsStore = {
      getRecordByThreadId: vi.fn().mockReturnValue(undefined),
      getRecordByStatusMessageId: vi.fn().mockImplementation((id: string) => {
        if (id === 'status-msg-123') return { cronId: 'cron-from-status-id', threadId: 'thread-1', disabled: false };
        return undefined;
      }),
      getRecord: vi.fn().mockReturnValue({ cronId: 'cron-from-status-id', threadId: 'thread-1', disabled: false }),
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

    expect(scheduler.register).toHaveBeenCalledWith(
      'thread-1', 'thread-1', 'guild-1', 'Job 1',
      expect.objectContaining({ schedule: '0 7 * * *' }),
      'cron-from-status-id',
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
      triggerType: 'schedule',
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

describe('threadCreate listener', () => {
  let initCronForum: typeof import('./forum-sync.js').initCronForum;
  let parseCronDefinition: typeof import('./parser.js').parseCronDefinition;

  beforeEach(async () => {
    ({ initCronForum } = await import('./forum-sync.js'));
    ({ parseCronDefinition } = await import('./parser.js'));
    vi.mocked(parseCronDefinition).mockReset();
  });

  async function setupAndGetListener(opts: { scheduler?: any; pendingThreadIds?: Set<string> } = {}) {
    const forum = makeForum([]);
    const client = makeClient(forum);
    const scheduler = opts.scheduler ?? makeScheduler();

    await initCronForum({
      client: client as any,
      forumChannelNameOrId: 'forum-1',
      allowUserIds: new Set(['u-allowed']),
      scheduler: scheduler as any,
      runtime: {} as any,
      cronModel: 'haiku',
      cwd: '/tmp',
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pendingThreadIds: opts.pendingThreadIds,
    });

    const threadCreateCallbacks = client._listeners['threadCreate'] ?? [];
    expect(threadCreateCallbacks.length).toBeGreaterThan(0);
    return { listener: threadCreateCallbacks[0], scheduler, client };
  }

  it('skips threads already registered in scheduler', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue({ id: 'thread-new' });
    const { listener } = await setupAndGetListener({ scheduler });

    const thread = makeThread({ id: 'thread-new', parentId: 'forum-1' });
    await listener(thread);

    // Should not call loadThreadAsCron (no fetchStarterMessage call).
    expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
  });

  it('skips threads in pendingThreadIds set', async () => {
    const pendingThreadIds = new Set(['thread-pending']);
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    const { listener } = await setupAndGetListener({ scheduler, pendingThreadIds });

    const thread = makeThread({ id: 'thread-pending', parentId: 'forum-1' });
    await listener(thread);

    expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
  });

  it('skips threads from other forums', async () => {
    const scheduler = makeScheduler();
    const { listener } = await setupAndGetListener({ scheduler });

    const thread = makeThread({ id: 'thread-other', parentId: 'other-forum' });
    await listener(thread);

    expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
  });

  it('processes new threads not in scheduler or pending set', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });
    const { listener } = await setupAndGetListener({ scheduler });

    vi.mocked(parseCronDefinition).mockResolvedValue({
      triggerType: 'schedule',
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });

    const thread = makeThread({ id: 'thread-brand-new', parentId: 'forum-1' });
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'every day at 7am say hello',
      author: { id: 'u-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });
    await listener(thread);

    expect(scheduler.register).toHaveBeenCalled();
  });

  it('rejects manually-created threads with guidance message and archives', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    const { listener } = await setupAndGetListener({ scheduler });

    const thread = makeThread({ id: 'thread-manual', parentId: 'forum-1', ownerId: 'some-user' });
    await listener(thread);

    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('cronCreate'));
    expect(thread.setArchived).toHaveBeenCalledWith(true);
    expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
  });

  it('allows bot-created threads through to loadThreadAsCron', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });
    const { listener } = await setupAndGetListener({ scheduler });

    vi.mocked(parseCronDefinition).mockResolvedValue({
      triggerType: 'schedule',
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });

    const thread = makeThread({ id: 'thread-bot', parentId: 'forum-1', ownerId: 'bot-user-1' });
    thread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'every day at 7am say hello',
      author: { id: 'bot-user-1' },
      react: vi.fn().mockResolvedValue(undefined),
    });
    await listener(thread);

    expect(thread.fetchStarterMessage).toHaveBeenCalled();
  });

  it('handles send failure gracefully during rejection', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    const { listener } = await setupAndGetListener({ scheduler });

    const thread = makeThread({ id: 'thread-manual-2', parentId: 'forum-1', ownerId: 'some-user' });
    thread.send.mockRejectedValue(new Error('Missing Access'));
    await listener(thread);

    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });
});

describe('threadUpdate listener', () => {
  let initCronForum: typeof import('./forum-sync.js').initCronForum;
  let parseCronDefinition: typeof import('./parser.js').parseCronDefinition;

  beforeEach(async () => {
    ({ initCronForum } = await import('./forum-sync.js'));
    ({ parseCronDefinition } = await import('./parser.js'));
    vi.mocked(parseCronDefinition).mockReset();
  });

  async function setupAndGetListener(opts: { scheduler?: any } = {}) {
    const forum = makeForum([]);
    const client = makeClient(forum);
    const scheduler = opts.scheduler ?? makeScheduler();

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

    const threadUpdateCallbacks = client._listeners['threadUpdate'] ?? [];
    expect(threadUpdateCallbacks.length).toBeGreaterThan(0);
    return { listener: threadUpdateCallbacks[0], scheduler, client };
  }

  it('rejects unarchived manual thread not in scheduler', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    const { listener } = await setupAndGetListener({ scheduler });

    const oldThread = makeThread({ id: 'thread-manual', parentId: 'forum-1', ownerId: 'some-user', archived: true });
    const newThread = makeThread({ id: 'thread-manual', parentId: 'forum-1', ownerId: 'some-user', archived: false });
    await listener(oldThread, newThread);

    expect(newThread.send).toHaveBeenCalledWith(expect.stringContaining('cronCreate'));
    expect(newThread.setArchived).toHaveBeenCalledWith(true);
  });

  it('allows unarchived grandfathered thread through', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue({ id: 'thread-grandfathered' });
    const { listener } = await setupAndGetListener({ scheduler });

    vi.mocked(parseCronDefinition).mockResolvedValue({
      triggerType: 'schedule',
      schedule: '0 7 * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });

    const oldThread = makeThread({ id: 'thread-grandfathered', parentId: 'forum-1', ownerId: 'some-user', archived: true });
    const newThread = makeThread({ id: 'thread-grandfathered', parentId: 'forum-1', ownerId: 'some-user', archived: false });
    newThread.fetchStarterMessage.mockResolvedValue({
      id: 'm1',
      content: 'every day at 7am say hello',
      author: { id: 'u-allowed' },
      react: vi.fn().mockResolvedValue(undefined),
    });
    scheduler.register.mockReturnValue({ cron: { nextRun: () => new Date() } });
    await listener(oldThread, newThread);

    // Should NOT be rejected — should proceed to loadThreadAsCron.
    expect(newThread.setArchived).not.toHaveBeenCalledWith(true);
  });

  it('rejects manual thread on name change when not in scheduler', async () => {
    const scheduler = makeScheduler();
    scheduler.getJob.mockReturnValue(undefined);
    const { listener } = await setupAndGetListener({ scheduler });

    const oldThread = makeThread({ id: 'thread-manual', parentId: 'forum-1', ownerId: 'some-user', name: 'Old Name' });
    const newThread = makeThread({ id: 'thread-manual', parentId: 'forum-1', ownerId: 'some-user', name: 'New Name' });
    await listener(oldThread, newThread);

    expect(newThread.send).toHaveBeenCalledWith(expect.stringContaining('cronCreate'));
    expect(newThread.setArchived).toHaveBeenCalledWith(true);
  });
});
