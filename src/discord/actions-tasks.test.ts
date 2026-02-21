import { describe, expect, it, vi } from 'vitest';
import { TASK_ACTION_TYPES } from '../tasks/task-action-contract.js';
import { executeTaskAction } from '../tasks/task-action-executor.js';
import { taskActionsPromptSection } from '../tasks/task-action-prompt.js';
import type { TaskContext } from '../tasks/task-context.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Mocks — override discord-sync and related modules
// ---------------------------------------------------------------------------

vi.mock('../tasks/discord-sync.js', () => ({
  resolveTasksForum: vi.fn(() => ({
    threads: {
      create: vi.fn(async () => ({ id: 'thread-new' })),
    },
  })),
  createTaskThread: vi.fn(async () => 'thread-new'),
  closeTaskThread: vi.fn(async () => {}),
  updateTaskThreadName: vi.fn(async () => {}),
  updateTaskStarterMessage: vi.fn(async () => true),
  updateTaskThreadTags: vi.fn(async () => false),
  ensureUnarchived: vi.fn(async () => {}),
  getThreadIdFromTask: vi.fn((task: any) => {
    const ref = task.externalRef ?? task.external_ref ?? '';
    if (ref.startsWith('discord:')) return ref.slice('discord:'.length);
    return null;
  }),
  findExistingThreadForTask: vi.fn(async () => null),
  reloadTagMapInPlace: vi.fn(async () => 2),
}));

vi.mock('../tasks/auto-tag.js', () => ({
  autoTagTask: vi.fn(async () => ['feature']),
}));

vi.mock('../tasks/task-sync-engine.js', () => {
  const runTaskSync = vi.fn(async () => ({
    threadsCreated: 1,
    emojisUpdated: 2,
    starterMessagesUpdated: 5,
    threadsArchived: 3,
    statusesUpdated: 4,
    tagsUpdated: 0,
    warnings: 0,
  }));
  return { runTaskSync };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ActionContext {
  return {
    guild: {} as any,
    client: {
      channels: {
        cache: {
          get: () => undefined,
        },
      },
    } as any,
    channelId: 'test-channel',
    messageId: 'test-message',
  };
}

function makeStore() {
  const defaultBead = (id: string) => ({
    id,
    title: 'Test bead',
    description: 'A test',
    status: 'open' as const,
    priority: 2,
    issue_type: 'task',
    owner: '',
    external_ref: 'discord:111222333',
    labels: ['feature'],
    comments: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });

  return {
    get: vi.fn((id: string) => {
      if (id === 'ws-notfound') return undefined;
      return defaultBead(id);
    }),
    list: vi.fn(() => [
      { id: 'ws-001', title: 'First', status: 'open', priority: 2 },
      { id: 'ws-002', title: 'Second', status: 'in_progress', priority: 1 },
    ]),
    create: vi.fn((params: any) => ({
      id: 'ws-new',
      title: params.title,
      description: params.description ?? '',
      status: 'open' as const,
      priority: params.priority ?? 2,
      issue_type: 'task',
      owner: '',
      external_ref: '',
      labels: params.labels ?? [],
      comments: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })),
    update: vi.fn((id: string) => defaultBead(id)),
    close: vi.fn((id: string) => ({ ...defaultBead(id), status: 'closed' as const })),
    addLabel: vi.fn((id: string) => defaultBead(id)),
  };
}

function makeTaskCtx(overrides?: Partial<TaskContext>): TaskContext {
  return {
    tasksCwd: '/tmp/test-beads',
    forumId: 'forum-123',
    tagMap: { feature: 'tag-1', bug: 'tag-2' },
    store: makeStore() as any,
    runtime: { id: 'other', capabilities: new Set(), invoke: async function* () {} } as any,
    autoTag: false,
    autoTagModel: 'haiku',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TASK_ACTION_TYPES', () => {
  it('contains all task action types', () => {
    expect(TASK_ACTION_TYPES.has('taskCreate')).toBe(true);
    expect(TASK_ACTION_TYPES.has('taskUpdate')).toBe(true);
    expect(TASK_ACTION_TYPES.has('taskClose')).toBe(true);
    expect(TASK_ACTION_TYPES.has('taskShow')).toBe(true);
    expect(TASK_ACTION_TYPES.has('taskList')).toBe(true);
    expect(TASK_ACTION_TYPES.has('taskSync')).toBe(true);
    expect(TASK_ACTION_TYPES.has('tagMapReload')).toBe(true);
  });

  it('does not contain non-task types', () => {
    expect(TASK_ACTION_TYPES.has('channelCreate')).toBe(false);
  });
});

describe('executeTaskAction', () => {
  it('taskCreate returns created bead summary', async () => {
    const result = await executeTaskAction(
      { type: 'taskCreate', title: 'New task', priority: 1 },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-new');
    expect((result as any).summary).toContain('New task');
  });

  it('taskCreate calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'taskCreate', title: 'Counted task' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('taskCreate fails without title', async () => {
    const result = await executeTaskAction(
      { type: 'taskCreate', title: '' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
  });

  it('taskCreate honors no-thread by skipping thread creation', async () => {
    const { createTaskThread } = await import('../tasks/discord-sync.js');
    (createTaskThread as any).mockClear?.();

    const result = await executeTaskAction(
      { type: 'taskCreate', title: 'No thread please', tags: 'no-thread,feature' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect(createTaskThread).not.toHaveBeenCalled();
  });

  it('taskCreate skips thread creation when task is already linked before direct lifecycle step', async () => {
    const { createTaskThread } = await import('../tasks/discord-sync.js');
    (createTaskThread as any).mockClear?.();

    const store = makeStore();
    (store.get as any).mockImplementation((id: string) => ({
      id,
      title: 'Already linked',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      owner: '',
      external_ref: 'discord:thread-existing',
      labels: ['feature'],
      comments: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }));

    const result = await executeTaskAction(
      { type: 'taskCreate', title: 'Task already linked' },
      makeCtx(),
      makeTaskCtx({ store: store as any }),
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('thread linked');
    expect(createTaskThread).not.toHaveBeenCalled();
  });

  it('taskUpdate returns updated summary', async () => {
    const result = await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', status: 'in_progress', priority: 1 },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('in_progress');
  });

  it('taskUpdate calls forumCountSync.requestUpdate when status changed', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('taskUpdate does NOT call forumCountSync.requestUpdate without status change', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', title: 'New title' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).not.toHaveBeenCalled();
  });

  it('taskUpdate fails without taskId', async () => {
    const result = await executeTaskAction(
      { type: 'taskUpdate', taskId: '' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
  });

  it('taskUpdate calls updateBeadStarterMessage when bead has a linked thread', async () => {
    const { updateTaskStarterMessage } = await import('../tasks/discord-sync.js');
    (updateTaskStarterMessage as any).mockClear();

    await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', description: 'Updated desc' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(updateTaskStarterMessage).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      undefined,
    );
  });

  it('taskUpdate passes sidebarMentionUserId to updateBeadStarterMessage', async () => {
    const { updateTaskStarterMessage } = await import('../tasks/discord-sync.js');
    (updateTaskStarterMessage as any).mockClear();

    await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', description: 'Updated desc' },
      makeCtx(),
      makeTaskCtx({ sidebarMentionUserId: '999' }),
    );
    expect(updateTaskStarterMessage).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      '999',
    );
  });

  it('taskUpdate succeeds even if updateBeadStarterMessage throws', async () => {
    const { updateTaskStarterMessage } = await import('../tasks/discord-sync.js');
    (updateTaskStarterMessage as any).mockRejectedValueOnce(new Error('Discord API error'));

    const result = await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
  });

  it('taskUpdate calls updateBeadThreadTags when bead has a linked thread', async () => {
    const { updateTaskThreadTags } = await import('../tasks/discord-sync.js');
    (updateTaskThreadTags as any).mockClear();

    await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(updateTaskThreadTags).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      expect.objectContaining({ feature: 'tag-1' }),
    );
  });

  it('taskClose passes tagMap to closeBeadThread', async () => {
    const { closeTaskThread } = await import('../tasks/discord-sync.js');
    (closeTaskThread as any).mockClear();

    const taskCtx = makeTaskCtx();
    await executeTaskAction(
      { type: 'taskClose', taskId: 'ws-001', reason: 'Done' },
      makeCtx(),
      taskCtx,
    );
    expect(closeTaskThread).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      taskCtx.tagMap,
      taskCtx.log,
    );
  });

  it('taskUpdate rejects invalid status', async () => {
    const result = await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', status: 'nonsense' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Invalid');
  });

  it('taskClose returns closed summary', async () => {
    const result = await executeTaskAction(
      { type: 'taskClose', taskId: 'ws-001', reason: 'Done' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('Done');
  });

  it('taskClose calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'taskClose', taskId: 'ws-001' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('taskShow returns bead details', async () => {
    const result = await executeTaskAction(
      { type: 'taskShow', taskId: 'ws-001' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Test bead');
    expect((result as any).summary).toContain('ws-001');
  });

  it('taskShow fails for unknown bead', async () => {
    const result = await executeTaskAction(
      { type: 'taskShow', taskId: 'ws-notfound' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('not found');
  });

  it('taskList returns bead list', async () => {
    const result = await executeTaskAction(
      { type: 'taskList', status: 'open', limit: 10 },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('ws-002');
  });

  it('taskList defaults to limit 50 when no limit provided', async () => {
    const store = makeStore();
    await executeTaskAction(
      { type: 'taskList', status: 'all' },
      makeCtx(),
      makeTaskCtx({ store: store as any }),
    );

    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('taskList respects explicit limit', async () => {
    const store = makeStore();
    await executeTaskAction(
      { type: 'taskList', status: 'all', limit: 5 },
      makeCtx(),
      makeTaskCtx({ store: store as any }),
    );

    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('taskSync returns extended sync summary', async () => {
    const result = await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('status-fixes');
    expect((result as any).summary).toContain('5 starters');
  });

  it('taskSync passes statusPoster through to runTaskSync', async () => {
    const { runTaskSync } = await import('../tasks/task-sync-engine.js');
    (runTaskSync as any).mockClear();

    const mockPoster = { taskSyncComplete: vi.fn() } as any;
    await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      makeTaskCtx({ statusPoster: mockPoster }),
    );

    expect(runTaskSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster: mockPoster, mentionUserId: undefined }),
    );
  });

  it('taskSync passes sidebarMentionUserId as mentionUserId to runTaskSync', async () => {
    const { runTaskSync } = await import('../tasks/task-sync-engine.js');
    (runTaskSync as any).mockClear();

    await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      makeTaskCtx({ sidebarMentionUserId: '999' }),
    );

    expect(runTaskSync).toHaveBeenCalledWith(
      expect.objectContaining({ mentionUserId: '999' }),
    );
  });

  it('taskSync lazily creates and reuses syncCoordinator when missing', async () => {
    const { runTaskSync } = await import('../tasks/task-sync-engine.js');
    (runTaskSync as any).mockClear();

    const taskCtx = makeTaskCtx();
    expect(taskCtx.syncCoordinator).toBeUndefined();

    await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      taskCtx,
    );
    const firstCoordinator = taskCtx.syncCoordinator;
    expect(firstCoordinator).toBeDefined();

    await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      taskCtx,
    );

    expect(taskCtx.syncCoordinator).toBe(firstCoordinator);
    expect(runTaskSync).toHaveBeenCalledTimes(2);
  });

  it('taskUpdate schedules repair sync after thread lifecycle failure without prewired coordinator', async () => {
    const { runTaskSync } = await import('../tasks/task-sync-engine.js');
    const { updateTaskThreadName } = await import('../tasks/discord-sync.js');
    (runTaskSync as any).mockClear();
    (updateTaskThreadName as any).mockRejectedValueOnce(new Error('rename failed'));

    const result = await executeTaskAction(
      { type: 'taskUpdate', taskId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runTaskSync).toHaveBeenCalled();
  });
});

describe('tagMapReload action', () => {
  it('success: returns old/new count with tag names', async () => {
    const { reloadTagMapInPlace } = await import('../tasks/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();
    (reloadTagMapInPlace as any).mockImplementationOnce(async (_path: string, tagMap: any) => {
      // Simulate reload: clear and add new tags
      for (const k of Object.keys(tagMap)) delete tagMap[k];
      Object.assign(tagMap, { bug: '111', feature: '222', docs: '333' });
      return 3;
    });

    const result = await executeTaskAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeTaskCtx({ tagMapPath: '/tmp/tag-map.json' }),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Tag map reloaded');
    expect((result as any).summary).toContain('bug');
    expect((result as any).summary).toContain('feature');
    expect((result as any).summary).toContain('docs');
  });

  it('success with >10 tags: truncates tag list display', async () => {
    const { reloadTagMapInPlace } = await import('../tasks/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();
    (reloadTagMapInPlace as any).mockImplementationOnce(async (_path: string, tagMap: any) => {
      for (const k of Object.keys(tagMap)) delete tagMap[k];
      for (let i = 0; i < 15; i++) tagMap[`tag${i}`] = `id${i}`;
      return 15;
    });

    const result = await executeTaskAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeTaskCtx({ tagMapPath: '/tmp/tag-map.json' }),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('(+5 more)');
  });

  it('failure: returns error with message, map preserved', async () => {
    const { reloadTagMapInPlace } = await import('../tasks/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();
    (reloadTagMapInPlace as any).mockRejectedValueOnce(new Error('ENOENT: file not found'));

    const tagMap = { existing: '999' };
    const result = await executeTaskAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeTaskCtx({ tagMapPath: '/tmp/tag-map.json', tagMap }),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Tag map reload failed');
    expect((result as any).error).toContain('ENOENT');
  });

  it('without tagMapPath: returns error', async () => {
    const result = await executeTaskAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeTaskCtx(), // No tagMapPath
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Tag map path not configured');
  });
});

describe('taskSync coordinator tagMap reload behavior', () => {
  it('reloads tag map before runTaskSync when tagMapPath is configured', async () => {
    const { reloadTagMapInPlace } = await import('../tasks/discord-sync.js');
    const { runTaskSync } = await import('../tasks/task-sync-engine.js');
    (reloadTagMapInPlace as any).mockClear();
    (runTaskSync as any).mockClear();

    await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      makeTaskCtx({ tagMapPath: '/tmp/tag-map.json' }),
    );

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/tmp/tag-map.json', expect.any(Object));
    expect(runTaskSync).toHaveBeenCalled();
  });

  it('does not attempt reload without tagMapPath', async () => {
    const { reloadTagMapInPlace } = await import('../tasks/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();

    await executeTaskAction(
      { type: 'taskSync' },
      makeCtx(),
      makeTaskCtx(), // No tagMapPath
    );

    expect(reloadTagMapInPlace).not.toHaveBeenCalled();
  });
});

describe('taskActionsPromptSection', () => {
  it('returns non-empty prompt section', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('taskCreate');
    expect(section).toContain('taskClose');
    expect(section).toContain('taskList');
  });

  it('includes tagMapReload in prompt section', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('tagMapReload');
  });

  it('includes task quality guidelines', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('imperative mood');
    expect(section).toContain('Description');
    expect(section).toContain('P0');
    expect(section).toContain('P1');
    expect(section).toContain('taskUpdate');
  });

  it('keeps guidelines block under 600 chars', () => {
    const section = taskActionsPromptSection();
    const marker = '#### Task Quality Guidelines';
    const crossRefMarker = '#### Cross-Task References';
    const idx = section.indexOf(marker);
    expect(idx).toBeGreaterThanOrEqual(0);
    const crossRefIdx = section.indexOf(crossRefMarker);
    // Slice up to the cross-task section (or end of string if not found)
    const end = crossRefIdx > idx ? crossRefIdx : section.length;
    const guidelinesBlock = section.slice(idx, end);
    expect(guidelinesBlock.length).toBeLessThanOrEqual(600);
  });

  it('includes cross-task references guideline', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('#### Cross-Task References');
    expect(section).toContain('taskShow');
    expect(section).toContain('taskUpdate');
    expect(section).toContain('taskSync');
  });
});
