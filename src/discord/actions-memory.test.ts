import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MEMORY_ACTION_TYPES, executeMemoryAction, memoryActionsPromptSection } from './actions-memory.js';
import type { MemoryContext } from './actions-memory.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockStore = {
  version: 1 as const,
  updatedAt: 1700000000000,
  items: [
    {
      id: 'durable-abc12345',
      kind: 'fact' as const,
      text: 'Works at Acme Corp',
      tags: [],
      status: 'active' as const,
      source: { type: 'manual' as const, channelId: 'ch1', channelName: 'general' },
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
    {
      id: 'durable-def67890',
      kind: 'preference' as const,
      text: 'Prefers Rust over Go',
      tags: [],
      status: 'active' as const,
      source: { type: 'summary' as const },
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
  ],
};

vi.mock('./durable-memory.js', () => ({
  loadDurableMemory: vi.fn(async (_dir: string, _userId: string) => {
    return JSON.parse(JSON.stringify(mockStore));
  }),
  saveDurableMemory: vi.fn(async () => {}),
  addItem: vi.fn((store: any, text: string, source: any, maxItems: number, kind?: string) => {
    store.items.push({
      id: `durable-new`,
      kind: kind ?? 'fact',
      text,
      tags: [],
      status: 'active',
      source,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return store;
  }),
  deprecateItems: vi.fn((store: any, substring: string) => {
    const needle = substring.toLowerCase();
    let deprecatedCount = 0;
    for (const item of store.items) {
      if (item.status !== 'active') continue;
      if (item.text.toLowerCase().includes(needle) && needle.length >= item.text.length * 0.6) {
        item.status = 'deprecated';
        deprecatedCount++;
      }
    }
    return { store, deprecatedCount };
  }),
  selectItemsForInjection: vi.fn((store: any, _maxChars: number) => {
    return store.items.filter((i: any) => i.status === 'active');
  }),
  formatDurableSection: vi.fn((items: any[]) => {
    return items.map((i: any) => `- [${i.kind}] ${i.text}`).join('\n');
  }),
}));

vi.mock('./durable-write-queue.js', () => ({
  durableWriteQueue: {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ActionContext {
  return {
    guild: {} as any,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
  };
}

function makeMemCtx(overrides?: Partial<MemoryContext>): MemoryContext {
  return {
    userId: 'user-123',
    durableDataDir: '/tmp/durable',
    durableMaxItems: 200,
    durableInjectMaxChars: 2000,
    channelId: 'ch-456',
    messageId: 'msg-789',
    guildId: 'guild-001',
    channelName: 'dev',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MEMORY_ACTION_TYPES', () => {
  it('contains all memory action types', () => {
    expect(MEMORY_ACTION_TYPES.has('memoryRemember')).toBe(true);
    expect(MEMORY_ACTION_TYPES.has('memoryForget')).toBe(true);
    expect(MEMORY_ACTION_TYPES.has('memoryShow')).toBe(true);
  });

  it('does not contain non-memory types', () => {
    expect(MEMORY_ACTION_TYPES.has('forgeCreate')).toBe(false);
    expect(MEMORY_ACTION_TYPES.has('planList')).toBe(false);
    expect(MEMORY_ACTION_TYPES.has('beadCreate')).toBe(false);
  });
});

describe('executeMemoryAction', () => {
  describe('memoryRemember', () => {
    it('stores a fact in durable memory', async () => {
      const { addItem } = await import('./durable-memory.js');
      const { saveDurableMemory } = await import('./durable-memory.js');

      const result = await executeMemoryAction(
        { type: 'memoryRemember', text: 'Uses TypeScript daily' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('Remembered');
        expect(result.summary).toContain('Uses TypeScript daily');
      }
      expect(addItem).toHaveBeenCalled();
      expect(saveDurableMemory).toHaveBeenCalled();
    });

    it('passes kind to addItem when specified', async () => {
      const { addItem } = await import('./durable-memory.js');

      await executeMemoryAction(
        { type: 'memoryRemember', text: 'Working on DiscoClaw', kind: 'project' },
        makeCtx(),
        makeMemCtx(),
      );

      expect(addItem).toHaveBeenCalledWith(
        expect.any(Object),
        'Working on DiscoClaw',
        expect.objectContaining({ type: 'discord' }),
        200,
        'project',
      );
    });

    it('defaults kind to fact', async () => {
      const { addItem } = await import('./durable-memory.js');

      await executeMemoryAction(
        { type: 'memoryRemember', text: 'Some fact' },
        makeCtx(),
        makeMemCtx(),
      );

      expect(addItem).toHaveBeenCalledWith(
        expect.any(Object),
        'Some fact',
        expect.any(Object),
        200,
        'fact',
      );
    });

    it('sets source type to discord with Discord metadata', async () => {
      const { addItem } = await import('./durable-memory.js');

      await executeMemoryAction(
        { type: 'memoryRemember', text: 'A fact' },
        makeCtx(),
        makeMemCtx(),
      );

      expect(addItem).toHaveBeenCalledWith(
        expect.any(Object),
        'A fact',
        expect.objectContaining({
          type: 'discord',
          channelId: 'ch-456',
          messageId: 'msg-789',
          guildId: 'guild-001',
          channelName: 'dev',
        }),
        200,
        'fact',
      );
    });

    it('fails without text', async () => {
      const result = await executeMemoryAction(
        { type: 'memoryRemember', text: '' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires text');
    });

    it('serializes writes through durableWriteQueue', async () => {
      const { durableWriteQueue } = await import('./durable-write-queue.js');

      await executeMemoryAction(
        { type: 'memoryRemember', text: 'Queued fact' },
        makeCtx(),
        makeMemCtx(),
      );

      expect(durableWriteQueue.run).toHaveBeenCalledWith('user-123', expect.any(Function));
    });
  });

  describe('memoryForget', () => {
    it('deprecates matching items', async () => {
      const { deprecateItems, saveDurableMemory } = await import('./durable-memory.js');

      const result = await executeMemoryAction(
        { type: 'memoryForget', substring: 'Prefers Rust over Go' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('Forgot');
        expect(result.summary).toContain('1 item(s)');
      }
      expect(deprecateItems).toHaveBeenCalled();
      expect(saveDurableMemory).toHaveBeenCalled();
    });

    it('reports when no items match', async () => {
      const result = await executeMemoryAction(
        { type: 'memoryForget', substring: 'x' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('No matching items');
      }
    });

    it('fails without substring', async () => {
      const result = await executeMemoryAction(
        { type: 'memoryForget', substring: '' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a substring');
    });

    it('does not save when nothing was deprecated', async () => {
      const { saveDurableMemory } = await import('./durable-memory.js');

      await executeMemoryAction(
        { type: 'memoryForget', substring: 'x' },
        makeCtx(),
        makeMemCtx(),
      );

      expect(saveDurableMemory).not.toHaveBeenCalled();
    });
  });

  describe('memoryShow', () => {
    it('shows durable memory items', async () => {
      const result = await executeMemoryAction(
        { type: 'memoryShow' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('[fact]');
        expect(result.summary).toContain('Works at Acme Corp');
        expect(result.summary).toContain('[preference]');
        expect(result.summary).toContain('Prefers Rust over Go');
      }
    });

    it('returns message when no items exist', async () => {
      const { loadDurableMemory } = await import('./durable-memory.js');
      (loadDurableMemory as any).mockResolvedValueOnce(null);

      const result = await executeMemoryAction(
        { type: 'memoryShow' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('No durable memory items');
      }
    });

    it('returns message when all items are deprecated', async () => {
      const { selectItemsForInjection } = await import('./durable-memory.js');
      (selectItemsForInjection as any).mockReturnValueOnce([]);

      const result = await executeMemoryAction(
        { type: 'memoryShow' },
        makeCtx(),
        makeMemCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('No durable memory items');
      }
    });
  });
});

describe('memoryActionsPromptSection', () => {
  it('returns non-empty prompt section', () => {
    const section = memoryActionsPromptSection();
    expect(section).toContain('memoryRemember');
    expect(section).toContain('memoryForget');
    expect(section).toContain('memoryShow');
  });

  it('includes memory guidelines', () => {
    const section = memoryActionsPromptSection();
    expect(section).toContain('proactively');
    expect(section).toContain('persist');
    expect(section).toContain('kind');
  });

  it('documents available kinds', () => {
    const section = memoryActionsPromptSection();
    expect(section).toContain('fact');
    expect(section).toContain('preference');
    expect(section).toContain('project');
    expect(section).toContain('constraint');
    expect(section).toContain('workflow');
  });
});
