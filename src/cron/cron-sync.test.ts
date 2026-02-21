import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';
import { runCronSync } from './cron-sync.js';
import type { CronSyncOptions } from './cron-sync.js';
import type { CronRunStats, CronRunRecord } from './run-stats.js';
import type { CronScheduler } from './scheduler.js';
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
    cronId: 'cron-test1',
    threadId: 'thread-1',
    runCount: 0,
    lastRunAt: null,
    lastRunStatus: null,
    cadence: null,
    purposeTags: [],
    disabled: false,
    model: null,
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
    removeRecord: vi.fn(async () => true),
    removeByThreadId: vi.fn(async () => true),
  } as unknown as CronRunStats;
}

function makeScheduler(jobs: Array<{ id: string; threadId: string; cronId: string; name: string; schedule: string; prompt: string }>): CronScheduler {
  return {
    listJobs: () => jobs.map((j) => ({ id: j.id, name: j.name, schedule: j.schedule, timezone: 'UTC', nextRun: null })),
    getJob: (id: string) => {
      const j = jobs.find((jj) => jj.id === id);
      if (!j) return undefined;
      return { id: j.id, cronId: j.cronId, threadId: j.threadId, guildId: 'g1', name: j.name, def: { schedule: j.schedule, timezone: 'UTC', channel: 'general', prompt: j.prompt }, cron: null, running: false };
    },
  } as unknown as CronScheduler;
}

function makeForum(threads: Array<{ id: string; name: string; parentId: string; appliedTags?: string[] }>) {
  const threadMap = new Map(threads.map((t) => [t.id, { ...t, appliedTags: t.appliedTags ?? [], edit: vi.fn(), setName: vi.fn() }]));
  return {
    id: 'forum-1',
    type: ChannelType.GuildForum,
    threads: {
      fetchActive: vi.fn(async () => ({ threads: threadMap })),
    },
  };
}

function makeClient(forum: ReturnType<typeof makeForum>) {
  return {
    channels: {
      cache: { get: (id: string) => id === forum.id ? forum : undefined },
      fetch: vi.fn(async (id: string) => id === forum.id ? forum : null),
    },
  };
}

const defaultTagMap = {
  monitoring: 'tag-1',
  cleanup: 'tag-2',
  daily: 'tag-3',
  weekly: 'tag-4',
};

// Mock ensureStatusMessage (from the cron discord-sync)
vi.mock('./discord-sync.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    ensureStatusMessage: vi.fn(async () => 'msg-1'),
  };
});

describe('runCronSync', () => {
  it('returns zeros when forum not found', async () => {
    const client = { channels: { cache: { get: () => undefined }, fetch: vi.fn(async () => null) } };
    const result = await runCronSync({
      client: client as any,
      forumId: 'missing',
      scheduler: makeScheduler([]),
      statsStore: makeStatsStore([]),
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: true,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.tagsApplied).toBe(0);
    expect(result.namesUpdated).toBe(0);
  });

  it('phase 1: applies tags to threads missing them', async () => {
    const forum = makeForum([{ id: 'thread-1', name: 'Test Job', parentId: 'forum-1' }]);
    const client = makeClient(forum);
    const record = makeRecord({ cronId: 'cron-1', threadId: 'thread-1' });
    const scheduler = makeScheduler([{ id: 'thread-1', threadId: 'thread-1', cronId: 'cron-1', name: 'Test Job', schedule: '0 7 * * *', prompt: 'Monitor health' }]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore: makeStatsStore([record]),
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: true,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.tagsApplied).toBe(1);
  });

  it('phase 1: reconciles applied tags when tag-map IDs change', async () => {
    const forum = makeForum([{ id: 'thread-1', name: 'Test Job', parentId: 'forum-1', appliedTags: ['old-tag', 'daily-old'] }]);
    const client = makeClient(forum);
    const record = makeRecord({
      cronId: 'cron-1',
      threadId: 'thread-1',
      cadence: 'daily',
      purposeTags: ['monitoring'],
      model: 'fast',
    });
    const scheduler = makeScheduler([{ id: 'thread-1', threadId: 'thread-1', cronId: 'cron-1', name: 'Test Job', schedule: '0 7 * * *', prompt: 'Monitor health' }]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore: makeStatsStore([record]),
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: true,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.tagsApplied).toBe(1);
    const thread = (await forum.threads.fetchActive()).threads.get('thread-1') as any;
    expect(thread.edit).toHaveBeenCalledWith({ appliedTags: ['tag-1', 'tag-3'] });
  });

  it('phase 2: updates thread names with cadence emoji', async () => {
    const forum = makeForum([{ id: 'thread-2', name: 'Old Name', parentId: 'forum-1' }]);
    const client = makeClient(forum);
    const record = makeRecord({ cronId: 'cron-2', threadId: 'thread-2', cadence: 'daily', purposeTags: ['monitoring'], model: 'haiku' });
    const scheduler = makeScheduler([{ id: 'thread-2', threadId: 'thread-2', cronId: 'cron-2', name: 'Daily Check', schedule: '0 7 * * *', prompt: 'Check things' }]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore: makeStatsStore([record]),
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.namesUpdated).toBe(1);
  });

  it('phase 4: detects orphan threads', async () => {
    const forum = makeForum([{ id: 'thread-orphan', name: 'Orphan', parentId: 'forum-1' }]);
    const client = makeClient(forum);
    const log = mockLog();

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler: makeScheduler([]),
      statsStore: makeStatsStore([]),
      runtime: makeMockRuntime(''),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log,
      throttleMs: 0,
    });

    expect(result.orphansDetected).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-orphan' }),
      expect.stringContaining('orphan'),
    );
  });
});
