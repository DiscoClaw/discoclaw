import { describe, expect, it, vi } from 'vitest';
import { executeCronAction, CRON_ACTION_TYPES } from './actions-crons.js';
import type { CronActionRequest, CronContext } from './actions-crons.js';
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
    unregister: vi.fn((id: string) => { jobMap.delete(id); return true; }),
    disable: vi.fn(() => true),
    enable: vi.fn(() => true),
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
    statsStore: makeStatsStore([makeRecord()]),
    runtime: makeMockRuntime('monitoring'),
    autoTag: false,
    autoTagModel: 'haiku',
    cwd: '/tmp',
    allowUserIds: new Set(['user-1']),
    log: mockLog(),
    ...overrides,
  };
}

// Mock loadTagMap
vi.mock('../beads/discord-sync.js', () => ({
  loadTagMap: vi.fn(async () => ({ monitoring: 'tag-1', daily: 'tag-2' })),
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

  it('cronResume enables the job', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronResume', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.scheduler.enable).toHaveBeenCalledWith('thread-1');
  });

  it('cronDelete unregisters and archives', async () => {
    const cronCtx = makeCronCtx();
    const result = await executeCronAction({ type: 'cronDelete', cronId: 'cron-test0001' }, makeActionCtx(), cronCtx);
    expect(result.ok).toBe(true);
    expect(cronCtx.scheduler.unregister).toHaveBeenCalledWith('thread-1');
    expect(cronCtx.statsStore.removeRecord).toHaveBeenCalledWith('cron-test0001');
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
      runCronSync: vi.fn(async () => ({ tagsApplied: 1, namesUpdated: 0, statusMessagesUpdated: 2, orphansDetected: 0 })),
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
});
