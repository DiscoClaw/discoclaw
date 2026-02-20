import { describe, expect, it, vi } from 'vitest';
import { TASK_ACTION_TYPES, executeTaskAction, taskActionsPromptSection } from './actions-tasks.js';
import type { TaskContext } from './actions-tasks.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Mocks — override discord-sync and related modules
// ---------------------------------------------------------------------------

vi.mock('../beads/discord-sync.js', () => ({
  resolveBeadsForum: vi.fn(() => ({
    threads: {
      create: vi.fn(async () => ({ id: 'thread-new' })),
    },
  })),
  createBeadThread: vi.fn(async () => 'thread-new'),
  closeBeadThread: vi.fn(async () => {}),
  updateBeadThreadName: vi.fn(async () => {}),
  updateBeadStarterMessage: vi.fn(async () => true),
  updateBeadThreadTags: vi.fn(async () => false),
  ensureUnarchived: vi.fn(async () => {}),
  getThreadIdFromBead: vi.fn((bead: any) => {
    const ref = bead.external_ref ?? '';
    if (ref.startsWith('discord:')) return ref.slice('discord:'.length);
    return null;
  }),
  reloadTagMapInPlace: vi.fn(async () => 2),
}));

vi.mock('../beads/auto-tag.js', () => ({
  autoTagBead: vi.fn(async () => ['feature']),
}));

vi.mock('../beads/bead-sync.js', () => ({
  runBeadSync: vi.fn(async () => ({
    threadsCreated: 1,
    emojisUpdated: 2,
    starterMessagesUpdated: 5,
    threadsArchived: 3,
    statusesUpdated: 4,
    tagsUpdated: 0,
    warnings: 0,
  })),
}));

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
    beadsCwd: '/tmp/test-beads',
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
    expect(TASK_ACTION_TYPES.has('beadCreate')).toBe(true);
    expect(TASK_ACTION_TYPES.has('beadUpdate')).toBe(true);
    expect(TASK_ACTION_TYPES.has('beadClose')).toBe(true);
    expect(TASK_ACTION_TYPES.has('beadShow')).toBe(true);
    expect(TASK_ACTION_TYPES.has('beadList')).toBe(true);
    expect(TASK_ACTION_TYPES.has('beadSync')).toBe(true);
    expect(TASK_ACTION_TYPES.has('tagMapReload')).toBe(true);
  });

  it('does not contain non-task types', () => {
    expect(TASK_ACTION_TYPES.has('channelCreate')).toBe(false);
  });
});

describe('executeTaskAction', () => {
  it('beadCreate returns created bead summary', async () => {
    const result = await executeTaskAction(
      { type: 'beadCreate', title: 'New task', priority: 1 },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-new');
    expect((result as any).summary).toContain('New task');
  });

  it('beadCreate calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'beadCreate', title: 'Counted task' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('beadCreate fails without title', async () => {
    const result = await executeTaskAction(
      { type: 'beadCreate', title: '' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
  });

  it('beadCreate honors no-thread by skipping thread creation', async () => {
    const { createBeadThread } = await import('../beads/discord-sync.js');
    (createBeadThread as any).mockClear?.();

    const result = await executeTaskAction(
      { type: 'beadCreate', title: 'No thread please', tags: 'no-thread,feature' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect(createBeadThread).not.toHaveBeenCalled();
  });

  it('beadUpdate returns updated summary', async () => {
    const result = await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress', priority: 1 },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('in_progress');
  });

  it('beadUpdate calls forumCountSync.requestUpdate when status changed', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('beadUpdate does NOT call forumCountSync.requestUpdate without status change', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', title: 'New title' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).not.toHaveBeenCalled();
  });

  it('beadUpdate fails without beadId', async () => {
    const result = await executeTaskAction(
      { type: 'beadUpdate', beadId: '' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
  });

  it('beadUpdate calls updateBeadStarterMessage when bead has a linked thread', async () => {
    const { updateBeadStarterMessage } = await import('../beads/discord-sync.js');
    (updateBeadStarterMessage as any).mockClear();

    await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', description: 'Updated desc' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(updateBeadStarterMessage).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      undefined,
    );
  });

  it('beadUpdate passes sidebarMentionUserId to updateBeadStarterMessage', async () => {
    const { updateBeadStarterMessage } = await import('../beads/discord-sync.js');
    (updateBeadStarterMessage as any).mockClear();

    await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', description: 'Updated desc' },
      makeCtx(),
      makeTaskCtx({ sidebarMentionUserId: '999' }),
    );
    expect(updateBeadStarterMessage).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      '999',
    );
  });

  it('beadUpdate succeeds even if updateBeadStarterMessage throws', async () => {
    const { updateBeadStarterMessage } = await import('../beads/discord-sync.js');
    (updateBeadStarterMessage as any).mockRejectedValueOnce(new Error('Discord API error'));

    const result = await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
  });

  it('beadUpdate calls updateBeadThreadTags when bead has a linked thread', async () => {
    const { updateBeadThreadTags } = await import('../beads/discord-sync.js');
    (updateBeadThreadTags as any).mockClear();

    await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(updateBeadThreadTags).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      expect.objectContaining({ feature: 'tag-1' }),
    );
  });

  it('beadClose passes tagMap to closeBeadThread', async () => {
    const { closeBeadThread } = await import('../beads/discord-sync.js');
    (closeBeadThread as any).mockClear();

    const taskCtx = makeTaskCtx();
    await executeTaskAction(
      { type: 'beadClose', beadId: 'ws-001', reason: 'Done' },
      makeCtx(),
      taskCtx,
    );
    expect(closeBeadThread).toHaveBeenCalledWith(
      expect.anything(),
      '111222333',
      expect.objectContaining({ id: 'ws-001' }),
      taskCtx.tagMap,
      taskCtx.log,
    );
  });

  it('beadUpdate rejects invalid status', async () => {
    const result = await executeTaskAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'nonsense' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Invalid');
  });

  it('beadClose returns closed summary', async () => {
    const result = await executeTaskAction(
      { type: 'beadClose', beadId: 'ws-001', reason: 'Done' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('Done');
  });

  it('beadClose calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeTaskAction(
      { type: 'beadClose', beadId: 'ws-001' },
      makeCtx(),
      makeTaskCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('beadShow returns bead details', async () => {
    const result = await executeTaskAction(
      { type: 'beadShow', beadId: 'ws-001' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Test bead');
    expect((result as any).summary).toContain('ws-001');
  });

  it('beadShow fails for unknown bead', async () => {
    const result = await executeTaskAction(
      { type: 'beadShow', beadId: 'ws-notfound' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('not found');
  });

  it('beadList returns bead list', async () => {
    const result = await executeTaskAction(
      { type: 'beadList', status: 'open', limit: 10 },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('ws-002');
  });

  it('beadList defaults to limit 50 when no limit provided', async () => {
    const store = makeStore();
    await executeTaskAction(
      { type: 'beadList', status: 'all' },
      makeCtx(),
      makeTaskCtx({ store: store as any }),
    );

    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('beadList respects explicit limit', async () => {
    const store = makeStore();
    await executeTaskAction(
      { type: 'beadList', status: 'all', limit: 5 },
      makeCtx(),
      makeTaskCtx({ store: store as any }),
    );

    expect(store.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('beadSync returns extended sync summary', async () => {
    const result = await executeTaskAction(
      { type: 'beadSync' },
      makeCtx(),
      makeTaskCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('status-fixes');
    expect((result as any).summary).toContain('5 starters');
  });

  it('beadSync passes statusPoster through to runBeadSync', async () => {
    const { runBeadSync } = await import('../beads/bead-sync.js');
    (runBeadSync as any).mockClear();

    const mockPoster = { beadSyncComplete: vi.fn() } as any;
    await executeTaskAction(
      { type: 'beadSync' },
      makeCtx(),
      makeTaskCtx({ statusPoster: mockPoster }),
    );

    expect(runBeadSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster: mockPoster, mentionUserId: undefined }),
    );
  });

  it('beadSync passes sidebarMentionUserId as mentionUserId to runBeadSync', async () => {
    const { runBeadSync } = await import('../beads/bead-sync.js');
    (runBeadSync as any).mockClear();

    await executeTaskAction(
      { type: 'beadSync' },
      makeCtx(),
      makeTaskCtx({ sidebarMentionUserId: '999' }),
    );

    expect(runBeadSync).toHaveBeenCalledWith(
      expect.objectContaining({ mentionUserId: '999' }),
    );
  });
});

describe('tagMapReload action', () => {
  it('success: returns old/new count with tag names', async () => {
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
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
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
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
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
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

describe('beadSync fallback with tagMapPath', () => {
  it('reloads tag map before runBeadSync in fallback path', async () => {
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
    const { runBeadSync } = await import('../beads/bead-sync.js');
    (reloadTagMapInPlace as any).mockClear();
    (runBeadSync as any).mockClear();

    await executeTaskAction(
      { type: 'beadSync' },
      makeCtx(),
      makeTaskCtx({ tagMapPath: '/tmp/tag-map.json' }),
    );

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/tmp/tag-map.json', expect.any(Object));
    expect(runBeadSync).toHaveBeenCalled();
  });

  it('does not attempt reload without tagMapPath', async () => {
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();

    await executeTaskAction(
      { type: 'beadSync' },
      makeCtx(),
      makeTaskCtx(), // No tagMapPath
    );

    expect(reloadTagMapInPlace).not.toHaveBeenCalled();
  });
});

describe('taskActionsPromptSection', () => {
  it('returns non-empty prompt section', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('beadCreate');
    expect(section).toContain('beadClose');
    expect(section).toContain('beadList');
  });

  it('includes tagMapReload in prompt section', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('tagMapReload');
  });

  it('includes bead quality guidelines', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('imperative mood');
    expect(section).toContain('Description');
    expect(section).toContain('P0');
    expect(section).toContain('P1');
    expect(section).toContain('beadUpdate');
  });

  it('keeps guidelines block under 600 chars', () => {
    const section = taskActionsPromptSection();
    const marker = '#### Bead Quality Guidelines';
    const crossRefMarker = '#### Cross-Bead References';
    const idx = section.indexOf(marker);
    expect(idx).toBeGreaterThanOrEqual(0);
    const crossRefIdx = section.indexOf(crossRefMarker);
    // Slice up to the cross-bead section (or end of string if not found)
    const end = crossRefIdx > idx ? crossRefIdx : section.length;
    const guidelinesBlock = section.slice(idx, end);
    expect(guidelinesBlock.length).toBeLessThanOrEqual(600);
  });

  it('includes cross-bead references guideline', () => {
    const section = taskActionsPromptSection();
    expect(section).toContain('#### Cross-Bead References');
    expect(section).toContain('beadShow');
    expect(section).toContain('beadUpdate');
    expect(section).toContain('sendMessage');
    expect(section).toContain('readMessages');
    expect(section).toContain('listPins');
    expect(section).toContain('stale');
  });
});
