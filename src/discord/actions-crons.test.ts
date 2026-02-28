import { describe, expect, it, vi } from 'vitest';
import { executeCronAction, CRON_ACTION_TYPES } from './actions-crons.js';
import type { CronContext } from './actions-crons.js';
import type { ActionContext } from './actions.js';
import type { CronRunRecord, CronRunStats } from '../cron/run-stats.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { RuntimeAdapter } from '../runtime/types.js';

function makeMockRuntime(output: string): RuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(),
    async *invoke() {
      yield { type: 'text_final' as const, text: output };
    },
  };
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRecord(overrides?: Partial<CronRunRecord>): CronRunRecord {
  return {
    cronId: 'cron-test0001',
    threadId: 'thread-1',
    runCount: 5,
    lastRunAt: '2025-01-15T10:00:00Z',
    lastRunStatus: 'success',
    cadence: 'daily',
    purposeTags: ['monitoring'],
    disabled: false,
    model: 'haiku',
    ...overrides,
  };
}

function makeStatsStore(records: CronRunRecord[]): CronRunStats {
  const store: Record<string, CronRunRecord> = {};
  for (const r of records) store[r.cronId] = r;

  return {
    getStore: () => ({ version: 1 as const, updatedAt: Date.now(), jobs: store }),
    getRecord: (id: string) => store[id],
    getRecordByThreadId: (tid: string) => Object.values(store).find((r) => r.threadId === tid),
    upsertRecord: vi.fn(async (cronId: string, threadId: string, updates?: Partial<CronRunRecord>) => {
      const existing = store[cronId] ?? makeRecord({ cronId, threadId });
      if (updates) Object.assign(existing, updates);
      store[cronId] = existing;
      return existing;
    }),
    recordRun: vi.fn(async () => {}),
    removeRecord: vi.fn(async (cronId: string) => { delete store[cronId]; return true; }),
    removeByThreadId: vi.fn(async () => true),
  } as unknown as CronRunStats;
}

function makeScheduler(jobs: Array<{ id: string; threadId: string; cronId: string; name: string; schedule: string }>): CronScheduler {
  const jobMap = new Map<string, any>(jobs.map((j) => [j.id, { id: j.id, cronId: j.cronId, threadId: j.threadId, guildId: 'guild-1', name: j.name, def: { schedule: j.schedule, timezone: 'UTC', channel: 'general', prompt: 'Test' }, cron: null, running: false }]));
  return {
    register: vi.fn((...args: any[]) => {
      const newJob = { id: args[0], cronId: args[5] ?? '', threadId: args[1], guildId: args[2], name: args[3], def: args[4], cron: null, running: false };
      jobMap.set(args[0], newJob);
      return newJob;
    }),
    unregister: vi.fn((id: string) => {
      const existed = jobMap.has(id);
      jobMap.delete(id);
      return existed;
    }),
    disable: vi.fn((id: string) => jobMap.has(id)),
    enable: vi.fn((id: string) => jobMap.has(id)),
    getJob: (id: string) => jobMap.get(id),
    listJobs: () => Array.from(jobMap.values()).map((j: any) => ({ id: j.id, name: j.name, schedule: j.def.schedule, timezone: j.def.timezone, nextRun: null })),
  } as unknown as CronScheduler;
}

function makeActionCtx(): ActionContext {
  return {
    guild: { id: 'guild-1' } as any,
    client: {} as any,
    channelId: 'ch-1',
    messageId: 'msg-1',
  };
}

function makeCronCtx(overrides?: Partial<CronContext>): CronContext {
  const forumThread = { id: 'new-thread', isThread: () => true, send: vi.fn(), fetchStarterMessage: vi.fn() };
  const forum = {
    id: 'forum-1',
    type: 15, // ChannelType.GuildForum
    threads: {
      create: vi.fn(async () => forumThread),
    },
  };
  const client = {
    channels: {
      cache: {
        get: vi.fn((id: string) => {
          if (id === 'forum-1') return forum;
          if (id === 'thread-1') return { id: 'thread-1', isThread: () => true, send: vi.fn(), fetchStarterMessage: vi.fn(), setArchived: vi.fn() };
          return undefined;
        }),
      },
      fetch: vi.fn(async (id: string) => id === 'forum-1' ? forum : null),
    },
    user: { id: 'bot-user' },
  };

  return {
    scheduler: makeScheduler([{ id: 'thread-1', threadId: 'thread-1', cronId: 'cron-test0001', name: 'Test Job', schedule: '0 7 * * *' }]),
    client: client as any,
    forumId: 'forum-1',
    tagMapPath: '/tmp/tags.json',
    tagMap: { monitoring: 'tag-1', daily: 'tag-2' },
    statsStore: makeStatsStore([makeRecord()]),
    runtime: makeMockRuntime('monitoring'),
    autoTag: false,
    autoTagModel: 'haiku',
    cwd: '/tmp',
    allowUserIds: new Set(['user-1']),
    log: mockLog(),
    pendingThreadIds: new Set<string>(),
    ...overrides,
  };
}

// Mock reloadCronTagMapInPlace (best-effort reload in actions)
vi.mock('../cron/tag-map.js', () => ({
  reloadCronTagMapInPlace: vi.fn(async () => 2),
}));

// Mock ensureStatusMessage
vi.mock('../cron/discord-sync.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    ensureStatusMessage: vi.fn(async () => 'msg-1'),
  };
});

describe('CRON_ACTION_TYPES', () => {
  it('includes all cron action types', () => {
    expect(CRON_ACTION_TYPES.has('cronCreate')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronUpdate')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronList')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronShow')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronPause')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronResume')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronDelete')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronTrigger')).toBe(true);
    expect(CRON_ACTION_TYPES.has('cronSync')).toBe(true);
  });
});

describe('executeCronAction', () => {
  it('cronList returns registered jobs', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronList' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('Test Job');
      expect(result.summary).toContain('cron-test0001');
    }
  });

  it('cronList returns empty message when no jobs', async () => {
    const cronCtx = makeCronCtx({ scheduler: makeScheduler([]) });
    const result = await executeCronAction({ type: 'cronList' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('No cron jobs');
  });

  it('cronShow returns details for known cronId', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('cron-test0001');
      expect(result.summary).toContain('haiku');
      expect(result.summary).toContain('monitoring');
    }
  });

  it('cronShow returns error for unknown cronId', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-nope' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
  });

  it('cronPause disables the job', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronPause', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.scheduler.disable).toHaveBeenCalledWith('thread-1');
  });

  it('cronPause returns error when scheduler job is missing', async () => {
    const cronCtx = makeCronCtx({ scheduler: makeScheduler([]) });
    const result = await executeCronAction({ type: 'cronPause', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not registered in scheduler');
  });

  it('cronResume enables the job', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronResume', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.scheduler.enable).toHaveBeenCalledWith('thread-1');
  });

  it('cronResume returns error when scheduler job is missing', async () => {
    const cronCtx = makeCronCtx({ scheduler: makeScheduler([]) });
    const result = await executeCronAction({ type: 'cronResume', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not registered in scheduler');
  });

  it('cronDelete unregisters and archives', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronDelete', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.scheduler.unregister).toHaveBeenCalledWith('thread-1');
    expect(cronCtx.statsStore.removeRecord).toHaveBeenCalledWith('cron-test0001');
  });

  it('cronDelete warns when archive fails', async () => {
    const cronCtx = makeCronCtx();
    // Override the cached thread to have a failing setArchived
    (cronCtx.client.channels.cache.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === 'thread-1') return { id: 'thread-1', isThread: () => true, send: vi.fn(), setArchived: vi.fn().mockRejectedValue(new Error('Missing Permissions')) };
      return undefined;
    });
    const result = await executeCronAction({ type: 'cronDelete', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('could not be archived');
    }
    expect(cronCtx.scheduler.unregister).toHaveBeenCalledWith('thread-1');
    expect(cronCtx.log?.warn).toHaveBeenCalled();
  });

  it('cronList shows running emoji when job is running', async () => {
    const cronCtx = makeCronCtx();
    const job = cronCtx.scheduler.getJob('thread-1');
    job!.running = true;
    const result = await executeCronAction({ type: 'cronList' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('\uD83D\uDD04');
    }
  });

  it('cronShow shows Runtime line when job is running', async () => {
    const cronCtx = makeCronCtx();
    const job = cronCtx.scheduler.getJob('thread-1');
    job!.running = true;
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('Runtime:');
    }
  });

  it('cronShow does not show Runtime line when job is not running', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).not.toContain('Runtime:');
    }
  });

  it('cronCreate calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    const cronCtx = makeCronCtx({ forumCountSync: mockSync as any });
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'New Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('cronDelete calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    const cronCtx = makeCronCtx({ forumCountSync: mockSync as any });
    const result = await executeCronAction(
      { type: 'cronDelete', cronId: 'cron-test0001' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('cronSync calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    const cronCtx = makeCronCtx({ forumCountSync: mockSync as any });
    const result = await executeCronAction({ type: 'cronSync' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('cronCreate validates required fields', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronCreate', name: '', schedule: '', channel: '', prompt: '' } as any, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
  });

  it('cronCreate creates thread and registers job', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'New Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('New Cron');
  });

  it('cronCreate rejects invalid schedule before creating a thread', async () => {
    const invoke = vi.fn(async function* () {
      yield { type: 'text_final' as const, text: 'monitoring' };
    });
    const runtime: RuntimeAdapter = {
      id: 'other',
      capabilities: new Set(),
      invoke,
    };
    const cronCtx = makeCronCtx({ runtime });
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'Bad Cron', schedule: 'not-a-cron', channel: 'general', prompt: 'Do something' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid cron definition');
    expect(cronCtx.scheduler.register).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    const forum = (cronCtx.client.channels.cache.get as ReturnType<typeof vi.fn>)('forum-1');
    expect(forum.threads.create).not.toHaveBeenCalled();
  });

  it('cronCreate reports timezone validation errors as definition errors', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      {
        type: 'cronCreate',
        name: 'TZ Fail',
        schedule: '0 7 * * *',
        timezone: 'Not/A_Real_Timezone',
        channel: 'general',
        prompt: 'Do something',
      },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid cron definition');
  });

  it('cronUpdate returns error for unknown cronId', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronUpdate', cronId: 'cron-nope' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
  });

  it('cronUpdate with model sets override', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronUpdate', cronId: 'cron-test0001', model: 'opus' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith('cron-test0001', 'thread-1', expect.objectContaining({ modelOverride: 'opus' }));
  });

  it('cronUpdate with silent sets silent flag', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronUpdate', cronId: 'cron-test0001', silent: true }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith('cron-test0001', 'thread-1', expect.objectContaining({ silent: true }));
  });

  it('cronUpdate with silent false clears silent flag', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronUpdate', cronId: 'cron-test0001', silent: false }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith('cron-test0001', 'thread-1', expect.objectContaining({ silent: false }));
  });

  it('cronUpdate rejects invalid schedule before thread edits or scheduler mutation', async () => {
    const cronCtx = makeCronCtx();
    const thread = (cronCtx.client.channels.cache.get as ReturnType<typeof vi.fn>)('thread-1');
    const starter = { author: { id: 'bot-user' }, edit: vi.fn() };
    thread.fetchStarterMessage = vi.fn(async () => starter);

    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', schedule: 'bad-schedule' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid cron definition');
    expect(starter.edit).not.toHaveBeenCalled();
    expect(cronCtx.scheduler.register).not.toHaveBeenCalled();
  });

  it('cronCreate without timezone uses getDefaultTimezone', async () => {
    vi.stubEnv('DEFAULT_TIMEZONE', 'America/Chicago');
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'TZ Test', schedule: '0 12 * * *', channel: 'general', prompt: 'Test timezone' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    // The scheduler.register call should receive a def with America/Chicago timezone.
    expect(cronCtx.scheduler.register).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'TZ Test',
      expect.objectContaining({ timezone: 'America/Chicago' }),
      expect.any(String),
    );
    vi.unstubAllEnvs();
  });

  it('cronCreate does not set modelOverride', async () => {
    const cronCtx = makeCronCtx();
    await executeCronAction(
      { type: 'cronCreate', name: 'New Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something', model: 'opus' },
      makeActionCtx(),
      cronCtx,
    );
    // Should set model but NOT modelOverride.
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.not.objectContaining({ modelOverride: expect.anything() }),
    );
  });

  it('cronTrigger returns ok for known job', async () => {
    // Mock the dynamic import of executeCronJob.
    vi.mock('../cron/executor.js', () => ({
      executeCronJob: vi.fn(async () => {}),
    }));

    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronTrigger', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('triggered');
  });

  it('cronTrigger returns error for unknown cronId', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronTrigger', cronId: 'cron-nope' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
  });

  it('cronSync returns sync results', async () => {
    // Mock the dynamic import of runCronSync.
    vi.mock('../cron/cron-sync.js', () => ({
      runCronSync: vi.fn(async () => ({ tagsApplied: 1, namesUpdated: 0, statusMessagesUpdated: 2, promptMessagesCreated: 0, orphansDetected: 0 })),
    }));

    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronSync' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('1 tags');
      expect(result.summary).toContain('2 status msgs');
    }
  });

  it('cronCreate returns error when thread creation fails', async () => {
    const forum = {
      id: 'forum-1',
      type: 15,
      threads: {
        create: vi.fn(async () => { throw new Error('Missing Permissions'); }),
      },
    };
    const client = {
      channels: {
        cache: { get: vi.fn((id: string) => id === 'forum-1' ? forum : undefined) },
        fetch: vi.fn(async (id: string) => id === 'forum-1' ? forum : null),
      },
      user: { id: 'bot-user' },
    };
    const cronCtx = makeCronCtx({ client: client as any });
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'Fail Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Test' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Missing Permissions');
  });

  it('cronTrigger force is rejected in Discord actions', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronTrigger', cronId: 'cron-test0001', force: true },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('force is disabled');
  });

  it('cronPause requests cancellation when a run is active', async () => {
    const runControl = { requestCancel: vi.fn(() => true) };
    const cronCtx = makeCronCtx({ executorCtx: { runControl } as any });
    const result = await executeCronAction({ type: 'cronPause', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(runControl.requestCancel).toHaveBeenCalledWith('thread-1');
    if (result.ok) expect(result.summary).toContain('cancel requested');
  });

  it('cronDelete requests cancellation when a run is active', async () => {
    const runControl = { requestCancel: vi.fn(() => true) };
    const cronCtx = makeCronCtx({ executorCtx: { runControl } as any });
    const result = await executeCronAction({ type: 'cronDelete', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(runControl.requestCancel).toHaveBeenCalledWith('thread-1');
    if (result.ok) expect(result.summary).toContain('cancel requested');
  });

  it('cronSync uses coordinator when present and returns result summary', async () => {
    const coordinator = {
      sync: vi.fn(async () => ({ tagsApplied: 2, namesUpdated: 1, statusMessagesUpdated: 3, promptMessagesCreated: 0, orphansDetected: 0 })),
    };
    const cronCtx = makeCronCtx({ syncCoordinator: coordinator as any });
    const result = await executeCronAction({ type: 'cronSync' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('2 tags');
      expect(result.summary).toContain('1 names');
      expect(result.summary).toContain('3 status msgs');
    }
    expect(coordinator.sync).toHaveBeenCalled();
  });

  it('cronSync coalesced case returns "already running" message', async () => {
    const coordinator = { sync: vi.fn(async () => null) };
    const cronCtx = makeCronCtx({ syncCoordinator: coordinator as any });
    const result = await executeCronAction({ type: 'cronSync' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('coalesced');
  });

  it('cronSync fallback when coordinator absent', async () => {
    vi.mock('../cron/cron-sync.js', () => ({
      runCronSync: vi.fn(async () => ({ tagsApplied: 1, namesUpdated: 0, statusMessagesUpdated: 2, promptMessagesCreated: 0, orphansDetected: 0 })),
    }));

    const cronCtx = makeCronCtx();
    // Ensure no coordinator
    delete (cronCtx as any).syncCoordinator;
    const result = await executeCronAction({ type: 'cronSync' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('1 tags');
    }
  });

  it('cronTagMapReload success with coordinator queues sync', async () => {
    const { reloadCronTagMapInPlace } = await import('../cron/tag-map.js');
    vi.mocked(reloadCronTagMapInPlace).mockResolvedValue(3);
    const coordinator = { sync: vi.fn(async () => null) };
    const cronCtx = makeCronCtx({ syncCoordinator: coordinator as any });
    const result = await executeCronAction({ type: 'cronTagMapReload' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('sync queued');
    }
  });

  it('cronTagMapReload success without coordinator', async () => {
    const { reloadCronTagMapInPlace } = await import('../cron/tag-map.js');
    vi.mocked(reloadCronTagMapInPlace).mockResolvedValue(2);
    const cronCtx = makeCronCtx();
    delete (cronCtx as any).syncCoordinator;
    const result = await executeCronAction({ type: 'cronTagMapReload' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('no sync coordinator configured');
    }
  });

  it('cronShow includes Prompt line with job prompt text', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('Prompt: Test');
    }
  });

  it('cronShow truncates prompt longer than 500 chars', async () => {
    const cronCtx = makeCronCtx();
    const job = cronCtx.scheduler.getJob('thread-1');
    job!.def.prompt = 'x'.repeat(600);
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('... (truncated)');
      expect(result.summary).not.toContain('x'.repeat(600));
    }
  });

  it('cronShow omits Prompt line when scheduler job is missing', async () => {
    const cronCtx = makeCronCtx({ scheduler: makeScheduler([]) });
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).not.toContain('Prompt:');
    }
  });

  it('cronUpdate fallback note includes prompt when starter is not bot-owned', async () => {
    const cronCtx = makeCronCtx();
    const threadSend = vi.fn(async () => ({}));
    const mockThread = {
      id: 'thread-1',
      isThread: () => true,
      send: threadSend,
      fetchStarterMessage: vi.fn(async () => ({ author: { id: 'other-user' }, edit: vi.fn() })),
      setArchived: vi.fn(),
    };
    (cronCtx.client.channels.cache.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'thread-1' ? mockThread : undefined,
    );
    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', prompt: 'New prompt text' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(threadSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('New prompt text') }),
    );
  });

  it('cronTagMapReload failure returns error', async () => {
    const { reloadCronTagMapInPlace } = await import('../cron/tag-map.js');
    vi.mocked(reloadCronTagMapInPlace).mockRejectedValue(new Error('bad json'));
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronTagMapReload' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('bad json');
  });

  it('CRON_ACTION_TYPES includes cronTagMapReload', () => {
    expect(CRON_ACTION_TYPES.has('cronTagMapReload')).toBe(true);
  });

  it('cronCreate with routingMode "json" persists it', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'JSON Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something', routingMode: 'json' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ routingMode: 'json' }),
    );
  });

  it('cronCreate with invalid routingMode rejects', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'Bad Routing', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something', routingMode: 'xml' as any },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"xml"');
  });

  it('cronCreate without routingMode does not set it', async () => {
    const cronCtx = makeCronCtx();
    await executeCronAction(
      { type: 'cronCreate', name: 'Plain Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something' },
      makeActionCtx(),
      cronCtx,
    );
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.not.objectContaining({ routingMode: expect.anything() }),
    );
  });

  it('cronCreate with allowedActions persists to stats store', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'Restricted Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Do something', allowedActions: 'cronList,cronShow' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ allowedActions: ['cronList', 'cronShow'] }),
    );
  });

  it('cronCreate rejects unrecognized allowedActions entries', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'Bad Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Test', allowedActions: 'cronList,fakeAction' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('fakeAction');
  });

  it('cronCreate rejects allowedActions with no valid entries', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronCreate', name: 'Empty Cron', schedule: '0 7 * * *', channel: 'general', prompt: 'Test', allowedActions: '  ,  ' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at least one entry');
  });

  it('cronUpdate with routingMode "json" sets it', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', routingMode: 'json' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      'cron-test0001',
      'thread-1',
      expect.objectContaining({ routingMode: 'json' }),
    );
  });

  it('cronUpdate with invalid routingMode rejects', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', routingMode: 'xml' as any },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('"xml"');
  });

  it('cronShow includes Routing line when routingMode is set', async () => {
    const cronCtx = makeCronCtx({
      statsStore: makeStatsStore([makeRecord({ routingMode: 'json' })]),
    });
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('Routing: json');
    }
  });

  it('cronShow omits Routing line when routingMode is absent', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).not.toContain('Routing:');
    }
  });

  it('cronUpdate with allowedActions persists to stats store', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', allowedActions: 'cronList,cronShow' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      'cron-test0001',
      'thread-1',
      expect.objectContaining({ allowedActions: ['cronList', 'cronShow'] }),
    );
  });

  it('cronUpdate with empty allowedActions clears the field', async () => {
    const cronCtx = makeCronCtx({
      statsStore: makeStatsStore([makeRecord({ allowedActions: ['cronList'] })]),
    });
    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', allowedActions: '' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(true);
    expect(cronCtx.statsStore.upsertRecord).toHaveBeenCalledWith(
      'cron-test0001',
      'thread-1',
      expect.objectContaining({ allowedActions: undefined }),
    );
  });

  it('cronUpdate rejects unrecognized allowedActions entries', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction(
      { type: 'cronUpdate', cronId: 'cron-test0001', allowedActions: 'cronList,badType' },
      makeActionCtx(),
      cronCtx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('badType');
  });

  it('cronShow includes allowedActions when configured', async () => {
    const cronCtx = makeCronCtx({
      statsStore: makeStatsStore([makeRecord({ allowedActions: ['cronList', 'cronShow'] })]),
    });
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('cronList');
      expect(result.summary).toContain('cronShow');
      expect(result.summary).toContain('Allowed actions:');
    }
  });

  it('cronShow omits Allowed actions line when not configured', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronShow', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).not.toContain('Allowed actions:');
    }
  });
});
