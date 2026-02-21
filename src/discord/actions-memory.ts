import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import {
  loadDurableMemory,
  saveDurableMemory,
  addItem,
  deprecateItems,
  selectItemsForInjection,
  formatDurableSection,
} from './durable-memory.js';
import type { DurableMemoryStore, DurableItem } from './durable-memory.js';
import { durableWriteQueue } from './durable-write-queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryActionRequest =
  | { type: 'memoryRemember'; text: string; kind?: DurableItem['kind'] }
  | { type: 'memoryForget'; substring: string }
  | { type: 'memoryShow' };

const MEMORY_TYPE_MAP: Record<MemoryActionRequest['type'], true> = {
  memoryRemember: true,
  memoryForget: true,
  memoryShow: true,
};
export const MEMORY_ACTION_TYPES = new Set<string>(Object.keys(MEMORY_TYPE_MAP));

export type MemoryContext = {
  userId: string;
  durableDataDir: string;
  durableMaxItems: number;
  durableInjectMaxChars: number;
  channelId?: string;
  messageId?: string;
  guildId?: string;
  channelName?: string;
  log?: LoggerLike;
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const VALID_KINDS: ReadonlySet<string> = new Set<DurableItem['kind']>([
  'fact', 'preference', 'project', 'constraint', 'person', 'tool', 'workflow',
]);

export async function executeMemoryAction(
  action: MemoryActionRequest,
  _ctx: ActionContext,
  memCtx: MemoryContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'memoryRemember': {
      if (!action.text) {
        return { ok: false, error: 'memoryRemember requires text' };
      }

      const kind = action.kind ?? 'fact';
      if (!VALID_KINDS.has(kind)) {
        return { ok: false, error: `Invalid memory kind: "${kind}". Must be one of: ${[...VALID_KINDS].join(', ')}` };
      }

      return durableWriteQueue.run(memCtx.userId, async () => {
        const store = await loadOrCreate(memCtx.durableDataDir, memCtx.userId);
        const source: DurableItem['source'] = { type: 'discord' };
        if (memCtx.channelId) source.channelId = memCtx.channelId;
        if (memCtx.messageId) source.messageId = memCtx.messageId;
        if (memCtx.guildId) source.guildId = memCtx.guildId;
        if (memCtx.channelName) source.channelName = memCtx.channelName;
        addItem(store, action.text, source, memCtx.durableMaxItems, kind as DurableItem['kind']);
        await saveDurableMemory(memCtx.durableDataDir, memCtx.userId, store);
        memCtx.log?.info({ action: 'memoryRemember', userId: memCtx.userId, textLength: action.text.length }, 'memory:action:remember');
        return { ok: true as const, summary: `Remembered: "${action.text}"` };
      });
    }

    case 'memoryForget': {
      if (!action.substring) {
        return { ok: false, error: 'memoryForget requires a substring' };
      }

      return durableWriteQueue.run(memCtx.userId, async () => {
        const store = await loadOrCreate(memCtx.durableDataDir, memCtx.userId);
        const { deprecatedCount } = deprecateItems(store, action.substring);
        if (deprecatedCount > 0) {
          await saveDurableMemory(memCtx.durableDataDir, memCtx.userId, store);
          memCtx.log?.info({ action: 'memoryForget', userId: memCtx.userId, textLength: action.substring.length, deprecatedCount }, 'memory:action:forget');
          return { ok: true as const, summary: `Forgot ${deprecatedCount} item(s) matching "${action.substring}"` };
        }
        return { ok: true as const, summary: `No matching items found for "${action.substring}"` };
      });
    }

    case 'memoryShow': {
      const store = await loadDurableMemory(memCtx.durableDataDir, memCtx.userId);
      const items = store
        ? selectItemsForInjection(store, memCtx.durableInjectMaxChars)
        : [];
      if (items.length === 0) {
        return { ok: true, summary: 'No durable memory items.' };
      }
      return { ok: true, summary: formatDurableSection(items) };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadOrCreate(dir: string, userId: string): Promise<DurableMemoryStore> {
  const store = await loadDurableMemory(dir, userId);
  return store ?? { version: 1, updatedAt: 0, items: [] };
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function memoryActionsPromptSection(): string {
  return `### Memory (Durable User Memory)

**memoryRemember** — Store a fact, preference, or note in the user's durable memory:
\`\`\`
<discord-action>{"type":"memoryRemember","text":"Prefers Rust over Go for systems work"}</discord-action>
<discord-action>{"type":"memoryRemember","text":"Working on API migration","kind":"project"}</discord-action>
\`\`\`
- \`text\` (required): The fact or note to remember.
- \`kind\` (optional): One of \`fact\`, \`preference\`, \`project\`, \`constraint\`, \`person\`, \`tool\`, \`workflow\`. Defaults to \`fact\`.

**memoryForget** — Deprecate matching items from the user's durable memory:
\`\`\`
<discord-action>{"type":"memoryForget","substring":"Prefers Rust over Go"}</discord-action>
\`\`\`
- \`substring\` (required): Text to match against. Items where this covers >= 60% of the item's text length are deprecated.

**memoryShow** — Show the user's current durable memory items:
\`\`\`
<discord-action>{"type":"memoryShow"}</discord-action>
\`\`\`

#### Memory Guidelines
- Use memoryRemember to proactively store important facts the user mentions (preferences, projects, tools, constraints).
- Pick the most specific \`kind\` that fits — it helps with organization and retrieval.
- Use memoryForget to clean up outdated or incorrect items.
- Memory items persist across sessions, channels, and restarts.`;
}
