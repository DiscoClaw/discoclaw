import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { DurableItem } from './durable-memory.js';
import {
  loadDurableMemory,
  saveDurableMemory,
  addItem,
  emptyStore,
} from './durable-memory.js';
import { durableWriteQueue } from './durable-write-queue.js';
import { extractFirstJsonValue } from './json-extract.js';

const VALID_KINDS = new Set<DurableItem['kind']>([
  'preference', 'fact', 'project', 'constraint', 'person', 'tool', 'workflow',
]);

export const CONSOLIDATION_PROMPT = `You are a long-term memory consolidator. Review all active memory items and return a revised, minimal list that eliminates redundancy while preserving all still-relevant substance.

## Active memory items (JSON)
{activeItems}

## Your task
1. **Merge near-duplicates**: if two or more items say essentially the same thing, merge them into a single, clearer item.
2. **Drop stale items**: remove items that are clearly no longer accurate or are transient in nature.
3. **Preserve substance**: keep all distinct facts, preferences, projects, constraints, tools, workflows, and relationships that are likely still relevant.
4. **Do not invent**: never add new information not present in the input items.

## Output format
Return a JSON array of objects with "kind", "text", and optional "retainedFrom" (an array of original item IDs this consolidated item was derived from, for the audit trail). Valid kinds: preference, fact, project, constraint, person, tool, workflow.

Return only the revised items that should remain active. The result must not be empty (if all items are valid, return them as-is or merged). Do not exceed the original item count.

JSON array:`;

export type ConsolidatedItem = {
  kind: DurableItem['kind'];
  text: string;
  retainedFrom?: string[];
};

function asConsolidatedItem(value: unknown): ConsolidatedItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { kind?: unknown; text?: unknown; retainedFrom?: unknown };
  if (typeof candidate.text !== 'string' || candidate.text.trim().length === 0) return null;
  if (!VALID_KINDS.has(candidate.kind as DurableItem['kind'])) return null;
  const result: ConsolidatedItem = {
    kind: candidate.kind as DurableItem['kind'],
    text: candidate.text.trim(),
  };
  if (Array.isArray(candidate.retainedFrom)) {
    const ids = (candidate.retainedFrom as unknown[]).filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    );
    if (ids.length > 0) result.retainedFrom = ids;
  }
  return result;
}

export function parseConsolidationResult(raw: string): ConsolidatedItem[] {
  try {
    const jsonArray = extractFirstJsonValue(raw, { arrayOnly: true });
    if (!jsonArray) return [];
    const parsed = JSON.parse(jsonArray) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => asConsolidatedItem(item))
      .filter((item): item is ConsolidatedItem => item !== null);
  } catch {
    return [];
  }
}

export type RunConsolidationOpts = {
  runtime: RuntimeAdapter;
  userId: string;
  durableDataDir: string;
  durableMaxItems: number;
  model: string;
  cwd: string;
  timeoutMs?: number;
  log?: LoggerLike;
};

export async function runConsolidation(
  opts: RunConsolidationOpts,
): Promise<{ originalCount: number; consolidatedCount: number }> {
  return durableWriteQueue.run(opts.userId, async () => {
    const store = (await loadDurableMemory(opts.durableDataDir, opts.userId)) ?? emptyStore();
    const activeItems = store.items.filter((it) => it.status === 'active');
    const originalCount = activeItems.length;

    if (originalCount === 0) return { originalCount: 0, consolidatedCount: 0 };

    const itemsJson = JSON.stringify(
      activeItems.map((it) => ({ id: it.id, kind: it.kind, text: it.text })),
    );
    const prompt = CONSOLIDATION_PROMPT.replace('{activeItems}', itemsJson);

    let finalText = '';
    let deltaText = '';
    for await (const evt of opts.runtime.invoke({
      prompt,
      model: opts.model,
      cwd: opts.cwd,
      tools: [],
      timeoutMs: opts.timeoutMs ?? 30_000,
    })) {
      if (evt.type === 'text_final') {
        finalText = evt.text;
      } else if (evt.type === 'text_delta') {
        deltaText += evt.text;
      } else if (evt.type === 'error') {
        opts.log?.warn({ userId: opts.userId }, '[consolidation] model error, aborting');
        return { originalCount, consolidatedCount: 0 };
      }
    }

    const raw = (finalText || deltaText).trim();
    const consolidated = parseConsolidationResult(raw);

    // Safety guard: empty result or exceeds original count → abort with no store mutations.
    if (consolidated.length === 0 || consolidated.length > originalCount) {
      opts.log?.warn(
        { userId: opts.userId, originalCount, consolidatedCount: consolidated.length },
        '[consolidation] safety guard triggered, aborting',
      );
      return { originalCount, consolidatedCount: 0 };
    }

    const now = Date.now();
    // Deprecate all original active items.
    for (const item of activeItems) {
      item.status = 'deprecated';
      item.updatedAt = now;
    }
    store.updatedAt = now;

    // Add consolidated items with source.type 'consolidation'.
    const source: DurableItem['source'] = { type: 'consolidation' };
    for (const item of consolidated) {
      addItem(store, item.text, source, opts.durableMaxItems, item.kind);
    }

    await saveDurableMemory(opts.durableDataDir, opts.userId, store);
    return { originalCount, consolidatedCount: consolidated.length };
  });
}

// Module-level set preventing overlapping maybeConsolidate runs per userId.
const consolidationInFlight = new Set<string>();

export type MaybeConsolidateOpts = RunConsolidationOpts & {
  threshold: number;
};

export async function maybeConsolidate(opts: MaybeConsolidateOpts): Promise<void> {
  const store = await loadDurableMemory(opts.durableDataDir, opts.userId);
  if (!store) return;
  const activeCount = store.items.filter((it) => it.status === 'active').length;
  if (activeCount < opts.threshold) return;
  if (consolidationInFlight.has(opts.userId)) return;

  consolidationInFlight.add(opts.userId);
  runConsolidation(opts)
    .catch((err: unknown) => {
      opts.log?.error({ err, userId: opts.userId }, '[consolidation] runConsolidation failed');
    })
    .finally(() => {
      consolidationInFlight.delete(opts.userId);
    });
}
