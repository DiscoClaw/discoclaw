import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { runCronSync } from './cron-sync.js';
import { buildCronThreadName } from './discord-sync.js';
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
      existing.threadId = threadId;
      store[cronId] = existing;
      return existing;
    }),
    recordRun: vi.fn(async () => {}),
    removeRecord: vi.fn(async () => true),
    removeByThreadId: vi.fn(async () => true),
    markProjectionMissing: vi.fn(async () => true),
    markProjectionDrifted: vi.fn(async () => true),
    queueResync: vi.fn(async () => true),
    getCanonicalDefinitions: vi.fn(() => {
      const snapshot: Record<string, CronRunRecord> = {};
      for (const [id, rec] of Object.entries(store)) snapshot[id] = { ...rec };
      return snapshot;
    }),
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
    getJobByCronId: (cronId: string) => {
      const j = jobs.find((jj) => jj.cronId === cronId);
      if (!j) return undefined;
      return { id: j.id, cronId: j.cronId, threadId: j.threadId, guildId: 'g1', name: j.name, def: { schedule: j.schedule, timezone: 'UTC', channel: 'general', prompt: j.prompt }, cron: null, running: false };
    },
    register: vi.fn(),
    unregister: vi.fn(),
    disable: vi.fn(),
  } as unknown as CronScheduler;
}

type ForumThreadFixture = {
  id: string;
  name: string;
  parentId: string;
  appliedTags?: string[];
  send?: (payload: { embeds?: unknown[]; allowedMentions?: { parse: string[] } }) => Promise<{ id: string; pin: () => Promise<unknown> }>;
  client?: { rest: object };
  edit?: (this: any, payload: { appliedTags?: string[]; name?: string }) => Promise<unknown>;
  setName?: (this: any, name: string) => Promise<unknown>;
};

function makeForum(
  threads: ForumThreadFixture[],
  opts?: {
    create?: (payload: { name: string; message: { content: string } }) => Promise<{ id: string }>;
  },
) {
  const threadMap = new Map(threads.map((fixture) => {
    const thread = {
      id: fixture.id,
      name: fixture.name,
      parentId: fixture.parentId,
      appliedTags: fixture.appliedTags ?? [],
      client: fixture.client ?? { rest: {} },
      isThread: () => true,
    } as any;

    thread.edit = fixture.edit ?? vi.fn(async function (this: any, payload: { appliedTags?: string[]; name?: string }) {
      if (payload.appliedTags) this.appliedTags = payload.appliedTags;
      if (payload.name) this.name = payload.name;
      return this;
    });
    thread.setName = fixture.setName ?? vi.fn(async function (this: any, name: string) {
      this.name = name;
      return this;
    });
    thread.send = fixture.send ?? vi.fn(async () => ({
      id: `msg-${thread.id}`,
      pin: vi.fn(async () => {}),
    }));

    return [thread.id, thread];
  }));
  return {
    id: 'forum-1',
    guildId: 'guild-1',
    type: ChannelType.GuildForum,
    threads: {
      fetchActive: vi.fn(async () => ({ threads: threadMap })),
      create: opts?.create ?? vi.fn(async ({ name, message }: { name: string; message: { content: string } }) => ({
        id: `thread-created-${threadMap.size + 1}`,
        name,
        message,
      })),
    },
  };
}

function makeClient(forum: ReturnType<typeof makeForum>, extraChannels: Array<{ id: string }> = []) {
  const channelEntries: Array<[string, any]> = [
    [forum.id, forum],
    ...extraChannels.map((channel): [string, any] => [channel.id, channel]),
  ];
  const channelMap = new Map<string, any>(channelEntries);
  return {
    channels: {
      cache: { get: (id: string) => channelMap.get(id) },
      fetch: vi.fn(async (id: string) => channelMap.get(id) ?? null),
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

  it('phase 2: keeps setName bound to the live thread instance', async () => {
    const expectedName = buildCronThreadName('Daily Check', 'daily');
    const edit = vi.fn(async function (this: any, payload: { name?: string }) {
      void this.client.rest;
      if (payload.name) this.name = payload.name;
      return this;
    });
    const setName = async function (this: any, name: string) {
      return this.edit({ name });
    };
    const forum = makeForum([{ id: 'thread-2', name: 'Old Name', parentId: 'forum-1', edit, setName }]);
    const client = makeClient(forum);
    const log = mockLog();
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
      log,
      throttleMs: 0,
    });

    expect(result.namesUpdated).toBe(1);
    const thread = (await forum.threads.fetchActive()).threads.get('thread-2') as any;
    expect(thread.name).toBe(expectedName);
    expect(edit).toHaveBeenCalledWith({ name: expectedName });
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-2' }),
      'cron-sync:phase2 name update failed',
    );
  });

  it('phase 1: keeps edit bound to the live thread instance', async () => {
    const edit = vi.fn(async function (this: any, payload: { appliedTags?: string[] }) {
      void this.client.rest;
      if (payload.appliedTags) this.appliedTags = payload.appliedTags;
      return this;
    });
    const forum = makeForum([{ id: 'thread-1', name: 'Test Job', parentId: 'forum-1', edit }]);
    const client = makeClient(forum);
    const log = mockLog();
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
      log,
      throttleMs: 0,
    });

    expect(result.tagsApplied).toBe(1);
    const thread = (await forum.threads.fetchActive()).threads.get('thread-1') as any;
    expect(thread.appliedTags).toEqual(['tag-1', 'tag-3']);
    expect(edit).toHaveBeenCalledWith({ appliedTags: ['tag-1', 'tag-3'] });
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1' }),
      'cron-sync:phase1 tag apply failed',
    );
  });

  it('continues with metadata/status phases when fetchActive fails', async () => {
    const forum = makeForum([]);
    (forum.threads.fetchActive as any).mockRejectedValueOnce(new Error('Discord API failure'));
    const client = makeClient(forum);
    const log = mockLog();
    const record = makeRecord({ cronId: 'cron-3', threadId: 'thread-3', cadence: 'daily', model: 'haiku' });
    const scheduler = makeScheduler([
      { id: 'thread-3', threadId: 'thread-3', cronId: 'cron-3', name: 'Daily Check', schedule: '0 7 * * *', prompt: 'Check things' },
    ]);

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
      log,
      throttleMs: 0,
    });

    expect(result.tagsApplied).toBe(0);
    expect(result.namesUpdated).toBe(0);
    expect(result.statusMessagesUpdated).toBe(1);
    expect(result.orphansDetected).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), forumId: 'forum-1' }),
      expect.stringContaining('failed to fetch active threads'),
    );
  });

  it('phase 3.5: backfills prompt messages with shell-input metadata from the canonical record', async () => {
    const forum = makeForum([{ id: 'thread-4', name: 'Shell Job', parentId: 'forum-1' }]);
    const thread = (await forum.threads.fetchActive()).threads.get('thread-4') as any;
    const client = makeClient(forum, [thread]);
    const statsStore = makeStatsStore([
      makeRecord({
        cronId: 'cron-4',
        threadId: 'thread-4',
        cadence: 'daily',
        purposeTags: ['monitoring'],
        model: 'haiku',
        prompt: 'Review the pre-command output and summarize actionable changes.',
        inputMode: 'shell',
        inputShell: 'printf "ready\\n"',
      }),
    ]);
    const scheduler = makeScheduler([
      {
        id: 'thread-4',
        threadId: 'thread-4',
        cronId: 'cron-4',
        name: 'Shell Job',
        schedule: '0 7 * * *',
        prompt: 'Review the pre-command output and summarize actionable changes.',
      },
    ]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore,
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.promptMessagesCreated).toBe(1);
    const payload = thread.send.mock.calls[0][0];
    expect(payload.embeds[0].data.description).toContain('**Input:** shell-input');
    expect(payload.embeds[0].data.description).toContain('printf "ready\\n"');
    expect(payload.embeds[0].data.description).toContain('Review the pre-command output');
    expect(statsStore.getRecord('cron-4')?.promptMessageId).toBe('msg-thread-4');
  });

  it('phase 5: recreates missing projections with shell-input metadata from the canonical record', async () => {
    const create = vi.fn(async ({ name, message }: { name: string; message: { content: string } }) => ({
      id: 'thread-new',
      name,
      message,
    }));
    const forum = makeForum([], { create });
    const client = makeClient(forum);
    const statsStore = makeStatsStore([
      makeRecord({
        cronId: 'cron-5',
        threadId: 'thread-old',
        cadence: 'daily',
        disabled: false,
        schedule: '0 7 * * *',
        timezone: 'UTC',
        channel: 'general',
        prompt: 'Review the pre-command output and summarize actionable changes.',
        inputMode: 'shell',
        inputShell: 'printf "ready\\n"',
        projectionStatus: 'missing',
        projectionHash: 'stale-hash',
      }),
    ]);
    const scheduler = makeScheduler([]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore,
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.projectionsRepaired).toBe(1);
    expect(create).toHaveBeenCalledWith({
      name: buildCronThreadName('Review the pre-command output and summarize action', 'daily'),
      message: {
        content: expect.stringContaining('**Input:** shell-input'),
      },
    });
    const starterContent = create.mock.calls[0][0].message.content;
    expect(starterContent).toContain('printf "ready\\n"');
    expect(starterContent).toContain('Review the pre-command output and summarize actionable changes.');
    expect(starterContent).toContain('[cronId:cron-5]');
    expect(statsStore.getRecord('cron-5')?.threadId).toBe('thread-new');
    expect(statsStore.getRecord('cron-5')?.projectionStatus).toBe('synced');
    expect((scheduler.register as any).mock.calls[0][0]).toBe('thread-new');
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

  it('sync preserves disabled flag without modifying it', async () => {
    const forum = makeForum([{ id: 'thread-1', name: 'Paused Job', parentId: 'forum-1' }]);
    const client = makeClient(forum);
    const statsStore = makeStatsStore([
      makeRecord({
        cronId: 'cron-1',
        threadId: 'thread-1',
        disabled: true,
        pauseSource: 'user',
        cadence: 'daily',
        purposeTags: ['monitoring'],
        model: 'haiku',
      }),
    ]);
    const scheduler = makeScheduler([
      { id: 'thread-1', threadId: 'thread-1', cronId: 'cron-1', name: 'Paused Job', schedule: '0 7 * * *', prompt: 'Check things' },
    ]);

    await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore,
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    // Verify disabled and pauseSource were not altered by sync
    const record = statsStore.getRecord('cron-1');
    expect(record?.disabled).toBe(true);
    expect(record?.pauseSource).toBe('user');
  });

  it('phase 5: recreating disabled cron calls scheduler.disable on new thread', async () => {
    const create = vi.fn(async ({ name, message }: { name: string; message: { content: string } }) => ({
      id: 'thread-new',
      name,
      message,
    }));
    const forum = makeForum([], { create });
    const client = makeClient(forum);
    const statsStore = makeStatsStore([
      makeRecord({
        cronId: 'cron-disabled',
        threadId: 'thread-old',
        disabled: true,
        pauseSource: 'user',
        cadence: 'daily',
        schedule: '0 7 * * *',
        timezone: 'UTC',
        channel: 'general',
        prompt: 'Disabled job that needs thread recreation.',
        projectionStatus: 'missing',
        projectionHash: 'stale-hash',
      }),
    ]);
    const scheduler = makeScheduler([]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore,
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    expect(result.projectionsRepaired).toBe(1);
    // Scheduler should have been called: register then disable
    expect(scheduler.register).toHaveBeenCalled();
    expect(scheduler.disable).toHaveBeenCalledWith('thread-new');
    // Record should still be disabled after recreation
    const record = statsStore.getRecord('cron-disabled');
    expect(record?.disabled).toBe(true);
    expect(record?.threadId).toBe('thread-new');
  });

  it('phase 3: updates status messages for disabled crons', async () => {
    const forum = makeForum([{ id: 'thread-1', name: 'Paused Job', parentId: 'forum-1' }]);
    const client = makeClient(forum);
    const statsStore = makeStatsStore([
      makeRecord({
        cronId: 'cron-1',
        threadId: 'thread-1',
        disabled: true,
        pauseSource: 'user',
        cadence: 'daily',
        model: 'haiku',
      }),
    ]);
    const scheduler = makeScheduler([
      { id: 'thread-1', threadId: 'thread-1', cronId: 'cron-1', name: 'Paused Job', schedule: '0 7 * * *', prompt: 'Check things' },
    ]);

    const result = await runCronSync({
      client: client as any,
      forumId: 'forum-1',
      scheduler,
      statsStore,
      runtime: makeMockRuntime('monitoring'),
      tagMap: { ...defaultTagMap },
      autoTag: false,
      autoTagModel: 'haiku',
      cwd: '/tmp',
      log: mockLog(),
      throttleMs: 0,
    });

    // Disabled crons should still get status message updates
    expect(result.statusMessagesUpdated).toBe(1);
  });
});
