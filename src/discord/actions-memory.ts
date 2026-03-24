import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import {
  loadDurableMemory,
  saveDurableMemory,
  addItem,
  deprecateItems,
  selectItemsForInjection,
  formatDurableSection,
  groupItemsByEntity,
  queryByEntity,
  formatEntityGroupedSection,
  CURRENT_VERSION,
} from './durable-memory.js';
import type { DurableMemoryStore, DurableItem } from './durable-memory.js';
import { durableWriteQueue } from './durable-write-queue.js';
import { loadSummary } from './summarizer.js';
import { loadShortTermMemory, selectEntriesForInjection, formatShortTermSection } from './shortterm-memory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryActionRequest =
  | { type: 'memoryRemember'; text: string; kind?: DurableItem['kind']; entity?: string }
  | { type: 'memoryForget'; substring: string }
  | { type: 'memoryShow' }
  | { type: 'memoryQuery'; entity: string };

const MEMORY_TYPE_MAP: Record<MemoryActionRequest['type'], true> = {
  memoryRemember: true,
  memoryForget: true,
  memoryShow: true,
  memoryQuery: true,
};
export const MEMORY_ACTION_TYPES = new Set<string>(Object.keys(MEMORY_TYPE_MAP));

export type MemoryContext = {
  userId: string;
  durableDataDir: string;
  durableMaxItems: number;
  durableInjectMaxChars: number;
  sessionKey?: string;
  summaryDataDir?: string;
  shortTermDataDir?: string;
  shortTermInjectMaxChars?: number;
  shortTermMaxAgeMs?: number;
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
        addItem(store, action.text, source, memCtx.durableMaxItems, kind as DurableItem['kind'], action.entity);
        await saveDurableMemory(memCtx.durableDataDir, memCtx.userId, store);
        memCtx.log?.info({ action: 'memoryRemember', userId: memCtx.userId, textLength: action.text.length, entity: action.entity }, 'memory:action:remember');
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
      const durableText = items.length > 0
        ? formatDurableSection(items)
        : '(none)';

      // Entity-grouped view
      const entityGroups = store ? groupItemsByEntity(store) : [];
      const entityText = entityGroups.length > 0
        ? formatEntityGroupedSection(entityGroups)
        : '(none)';

      let summaryText = '(none)';
      if (memCtx.sessionKey && memCtx.summaryDataDir) {
        try {
          const summary = await loadSummary(memCtx.summaryDataDir, memCtx.sessionKey);
          if (summary) summaryText = summary.summary;
        } catch {
          // best-effort
        }
      }

      let shortTermText = '(none)';
      if (memCtx.shortTermDataDir && memCtx.guildId) {
        try {
          const guildUserId = `${memCtx.guildId}-${memCtx.userId}`;
          const stStore = await loadShortTermMemory(memCtx.shortTermDataDir, guildUserId);
          if (stStore) {
            const maxChars = memCtx.shortTermInjectMaxChars ?? 1000;
            const maxAgeMs = memCtx.shortTermMaxAgeMs ?? 6 * 60 * 60 * 1000;
            const entries = selectEntriesForInjection(stStore, maxChars, maxAgeMs);
            if (entries.length > 0) {
              shortTermText = formatShortTermSection(entries);
            }
          }
        } catch {
          // best-effort
        }
      }

      return {
        ok: true,
        summary: `**Durable memory:**\n${durableText}\n\n**By entity:**\n${entityText}\n\n**Rolling summary:**\n${summaryText}\n\n**Short-term memory:**\n${shortTermText}`,
      };
    }

    case 'memoryQuery': {
      if (!action.entity) {
        return { ok: false, error: 'memoryQuery requires an entity name' };
      }

      const store = await loadDurableMemory(memCtx.durableDataDir, memCtx.userId);
      if (!store) {
        return { ok: true, summary: `No memory items found for entity "${action.entity}"` };
      }

      const matches = queryByEntity(store, action.entity);
      if (matches.length === 0) {
        return { ok: true, summary: `No memory items found for entity "${action.entity}"` };
      }

      const lines = matches.map(
        (item) => `- [${item.kind}] ${item.text}${item.entity ? ` (entity: ${item.entity})` : ''}`,
      );
      return {
        ok: true,
        summary: `**Memory for "${action.entity}"** (${matches.length} items):\n${lines.join('\n')}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadOrCreate(dir: string, userId: string): Promise<DurableMemoryStore> {
  const store = await loadDurableMemory(dir, userId);
  return store ?? { version: CURRENT_VERSION, updatedAt: 0, items: [] };
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function memoryActionsPromptSection(): string {
  return `### Memory (Durable User Memory)

**memoryRemember** — \`{"type":"memoryRemember","text":"Prefers Rust over Go","kind":"preference","entity":"David"}\`
\`text\` required. \`kind\` optional: fact (default), preference, project, constraint, person, tool, workflow.
\`entity\` optional: tag the item with an entity name (person, project, tool, etc.) for grouped retrieval.

**memoryForget** — \`{"type":"memoryForget","substring":"Prefers Rust over Go"}\`
Deprecates items where substring covers >= 60% of text length.

**memoryShow** — \`{"type":"memoryShow"}\`
Shows all memory sections including entity-grouped view.

**memoryQuery** — \`{"type":"memoryQuery","entity":"David"}\`
\`entity\` required. Returns all items tagged with a matching entity name (case-insensitive substring match).
Use for "what do I know about X" queries.

Proactively store important user facts/preferences. Memory persists across sessions and restarts.
When remembering facts about a specific person, project, or tool, include the \`entity\` tag for better retrieval.`;
}
