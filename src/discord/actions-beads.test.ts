import { describe, expect, it, vi } from 'vitest';
import { BEAD_ACTION_TYPES, executeBeadAction, beadActionsPromptSection } from './actions-beads.js';
import type { BeadContext } from './actions-beads.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Mocks — override bd-cli and discord-sync modules
// ---------------------------------------------------------------------------

vi.mock('../beads/bd-cli.js', () => ({
  bdShow: vi.fn(async (id: string) => {
    if (id === 'ws-notfound') return null;
    return {
      id,
      title: 'Test bead',
      description: 'A test',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      owner: '',
      external_ref: 'discord:111222333',
      labels: ['feature'],
      comments: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  }),
  bdList: vi.fn(async () => [
    { id: 'ws-001', title: 'First', status: 'open', priority: 2 },
    { id: 'ws-002', title: 'Second', status: 'in_progress', priority: 1 },
  ]),
  bdCreate: vi.fn(async (params: any) => ({
    id: 'ws-new',
    title: params.title,
    description: params.description ?? '',
    status: 'open',
    priority: params.priority ?? 2,
    issue_type: 'task',
    owner: '',
    external_ref: '',
    labels: params.labels ?? [],
    comments: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })),
  bdUpdate: vi.fn(async () => {}),
  bdClose: vi.fn(async () => {}),
}));

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
    warnings: 0,
  })),
}));

vi.mock('execa', () => ({
  execa: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
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

function makeBeadCtx(overrides?: Partial<BeadContext>): BeadContext {
  return {
    beadsCwd: '/tmp/test-beads',
    forumId: 'forum-123',
    tagMap: { feature: 'tag-1', bug: 'tag-2' },
    runtime: { id: 'other', capabilities: new Set(), invoke: async function* () {} } as any,
    autoTag: false,
    autoTagModel: 'haiku',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BEAD_ACTION_TYPES', () => {
  it('contains all bead action types', () => {
    expect(BEAD_ACTION_TYPES.has('beadCreate')).toBe(true);
    expect(BEAD_ACTION_TYPES.has('beadUpdate')).toBe(true);
    expect(BEAD_ACTION_TYPES.has('beadClose')).toBe(true);
    expect(BEAD_ACTION_TYPES.has('beadShow')).toBe(true);
    expect(BEAD_ACTION_TYPES.has('beadList')).toBe(true);
    expect(BEAD_ACTION_TYPES.has('beadSync')).toBe(true);
    expect(BEAD_ACTION_TYPES.has('tagMapReload')).toBe(true);
  });

  it('does not contain non-bead types', () => {
    expect(BEAD_ACTION_TYPES.has('channelCreate')).toBe(false);
  });
});

describe('executeBeadAction', () => {
  it('beadCreate returns created bead summary', async () => {
    const result = await executeBeadAction(
      { type: 'beadCreate', title: 'New task', priority: 1 },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-new');
    expect((result as any).summary).toContain('New task');
  });

  it('beadCreate calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeBeadAction(
      { type: 'beadCreate', title: 'Counted task' },
      makeCtx(),
      makeBeadCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('beadCreate fails without title', async () => {
    const result = await executeBeadAction(
      { type: 'beadCreate', title: '' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(false);
  });

  it('beadCreate honors no-thread by skipping thread creation', async () => {
    const { createBeadThread } = await import('../beads/discord-sync.js');
    (createBeadThread as any).mockClear?.();

    const result = await executeBeadAction(
      { type: 'beadCreate', title: 'No thread please', tags: 'no-thread,feature' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect(createBeadThread).not.toHaveBeenCalled();
  });

  it('beadUpdate returns updated summary', async () => {
    const result = await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress', priority: 1 },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('in_progress');
  });

  it('beadUpdate calls forumCountSync.requestUpdate when status changed', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeBeadCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('beadUpdate does NOT call forumCountSync.requestUpdate without status change', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', title: 'New title' },
      makeCtx(),
      makeBeadCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).not.toHaveBeenCalled();
  });

  it('beadUpdate fails without beadId', async () => {
    const result = await executeBeadAction(
      { type: 'beadUpdate', beadId: '' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(false);
  });

  it('beadUpdate calls updateBeadStarterMessage when bead has a linked thread', async () => {
    const { updateBeadStarterMessage } = await import('../beads/discord-sync.js');
    (updateBeadStarterMessage as any).mockClear();

    await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', description: 'Updated desc' },
      makeCtx(),
      makeBeadCtx(),
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

    await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', description: 'Updated desc' },
      makeCtx(),
      makeBeadCtx({ sidebarMentionUserId: '999' }),
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

    const result = await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'in_progress' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
  });

  it('beadUpdate rejects invalid status', async () => {
    const result = await executeBeadAction(
      { type: 'beadUpdate', beadId: 'ws-001', status: 'nonsense' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Invalid');
  });

  it('beadClose returns closed summary', async () => {
    const result = await executeBeadAction(
      { type: 'beadClose', beadId: 'ws-001', reason: 'Done' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('Done');
  });

  it('beadClose calls forumCountSync.requestUpdate', async () => {
    const mockSync = { requestUpdate: vi.fn(), stop: vi.fn() };
    await executeBeadAction(
      { type: 'beadClose', beadId: 'ws-001' },
      makeCtx(),
      makeBeadCtx({ forumCountSync: mockSync as any }),
    );
    expect(mockSync.requestUpdate).toHaveBeenCalled();
  });

  it('beadShow returns bead details', async () => {
    const result = await executeBeadAction(
      { type: 'beadShow', beadId: 'ws-001' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Test bead');
    expect((result as any).summary).toContain('ws-001');
  });

  it('beadShow fails for unknown bead', async () => {
    const result = await executeBeadAction(
      { type: 'beadShow', beadId: 'ws-notfound' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('not found');
  });

  it('beadList returns bead list', async () => {
    const result = await executeBeadAction(
      { type: 'beadList', status: 'open', limit: 10 },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('ws-001');
    expect((result as any).summary).toContain('ws-002');
  });

  it('beadSync returns extended sync summary', async () => {
    const result = await executeBeadAction(
      { type: 'beadSync' },
      makeCtx(),
      makeBeadCtx(),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('status-fixes');
    expect((result as any).summary).toContain('5 starters');
  });

  it('beadSync passes statusPoster through to runBeadSync', async () => {
    const { runBeadSync } = await import('../beads/bead-sync.js');
    (runBeadSync as any).mockClear();

    const mockPoster = { beadSyncComplete: vi.fn() } as any;
    await executeBeadAction(
      { type: 'beadSync' },
      makeCtx(),
      makeBeadCtx({ statusPoster: mockPoster }),
    );

    expect(runBeadSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster: mockPoster, mentionUserId: undefined }),
    );
  });

  it('beadSync passes sidebarMentionUserId as mentionUserId to runBeadSync', async () => {
    const { runBeadSync } = await import('../beads/bead-sync.js');
    (runBeadSync as any).mockClear();

    await executeBeadAction(
      { type: 'beadSync' },
      makeCtx(),
      makeBeadCtx({ sidebarMentionUserId: '999' }),
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

    const result = await executeBeadAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeBeadCtx({ tagMapPath: '/tmp/tag-map.json' }),
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

    const result = await executeBeadAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeBeadCtx({ tagMapPath: '/tmp/tag-map.json' }),
    );
    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('(+5 more)');
  });

  it('failure: returns error with message, map preserved', async () => {
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();
    (reloadTagMapInPlace as any).mockRejectedValueOnce(new Error('ENOENT: file not found'));

    const tagMap = { existing: '999' };
    const result = await executeBeadAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeBeadCtx({ tagMapPath: '/tmp/tag-map.json', tagMap }),
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Tag map reload failed');
    expect((result as any).error).toContain('ENOENT');
  });

  it('without tagMapPath: returns error', async () => {
    const result = await executeBeadAction(
      { type: 'tagMapReload' },
      makeCtx(),
      makeBeadCtx(), // No tagMapPath
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

    await executeBeadAction(
      { type: 'beadSync' },
      makeCtx(),
      makeBeadCtx({ tagMapPath: '/tmp/tag-map.json' }),
    );

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/tmp/tag-map.json', expect.any(Object));
    expect(runBeadSync).toHaveBeenCalled();
  });

  it('does not attempt reload without tagMapPath', async () => {
    const { reloadTagMapInPlace } = await import('../beads/discord-sync.js');
    (reloadTagMapInPlace as any).mockClear();

    await executeBeadAction(
      { type: 'beadSync' },
      makeCtx(),
      makeBeadCtx(), // No tagMapPath
    );

    expect(reloadTagMapInPlace).not.toHaveBeenCalled();
  });
});

describe('beadActionsPromptSection', () => {
  it('returns non-empty prompt section', () => {
    const section = beadActionsPromptSection();
    expect(section).toContain('beadCreate');
    expect(section).toContain('beadClose');
    expect(section).toContain('beadList');
  });

  it('includes tagMapReload in prompt section', () => {
    const section = beadActionsPromptSection();
    expect(section).toContain('tagMapReload');
  });

  it('includes bead quality guidelines', () => {
    const section = beadActionsPromptSection();
    expect(section).toContain('imperative mood');
    expect(section).toContain('Description');
    expect(section).toContain('P0');
    expect(section).toContain('P1');
    expect(section).toContain('beadUpdate');
  });

  it('keeps guidelines block under 600 chars', () => {
    const section = beadActionsPromptSection();
    const marker = '#### Bead Quality Guidelines';
    const idx = section.indexOf(marker);
    expect(idx).toBeGreaterThanOrEqual(0);
    const guidelinesBlock = section.slice(idx);
    expect(guidelinesBlock.length).toBeLessThanOrEqual(600);
  });
});
