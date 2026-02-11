import type { RuntimeAdapter } from '../runtime/types.js';
import type { DurableItem } from './durable-memory.js';
import { loadDurableMemory, saveDurableMemory, addItem } from './durable-memory.js';
import { durableWriteQueue } from './durable-write-queue.js';

const VALID_KINDS = new Set<DurableItem['kind']>([
  'preference', 'fact', 'project', 'constraint', 'person', 'tool', 'workflow',
]);

const EXTRACTION_PROMPT = `You are a fact extractor. Given a user's message, extract at most 3 notable long-term facts, preferences, or decisions stated by the user. Only extract information the user explicitly stated. Return a JSON array of objects with "kind" and "text" fields. Valid kinds: preference, fact, project, constraint, person, tool, workflow. If nothing is worth remembering, return [].

User message:
{userMessage}

JSON array:`;

const MAX_ITEMS_PER_EXTRACTION = 3;

export type ExtractedItem = { kind: DurableItem['kind']; text: string };

export async function extractFromUserTurn(
  runtime: RuntimeAdapter,
  opts: { userMessageText: string; model: string; cwd: string; timeoutMs?: number },
): Promise<ExtractedItem[]> {
  const prompt = EXTRACTION_PROMPT.replace('{userMessage}', opts.userMessageText);

  let finalText = '';
  let deltaText = '';

  for await (const evt of runtime.invoke({
    prompt,
    model: opts.model,
    cwd: opts.cwd,
    tools: [],
    timeoutMs: opts.timeoutMs ?? 15_000,
  })) {
    if (evt.type === 'text_final') {
      finalText = evt.text;
    } else if (evt.type === 'text_delta') {
      deltaText += evt.text;
    } else if (evt.type === 'error') {
      return [];
    }
  }

  const raw = (finalText || deltaText).trim();
  return parseExtractionResult(raw);
}

export function parseExtractionResult(raw: string): ExtractedItem[] {
  try {
    // Try to find the JSON array in the response (may have markdown fences).
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item: any) =>
          item &&
          typeof item === 'object' &&
          typeof item.text === 'string' &&
          item.text.trim().length > 0 &&
          VALID_KINDS.has(item.kind),
      )
      .map((item: any) => ({ kind: item.kind as DurableItem['kind'], text: item.text.trim() }))
      .slice(0, MAX_ITEMS_PER_EXTRACTION);
  } catch {
    return [];
  }
}

export type ApplyUserTurnToDurableOpts = {
  runtime: RuntimeAdapter;
  userMessageText: string;
  userId: string;
  durableDataDir: string;
  durableMaxItems: number;
  model: string;
  cwd: string;
};

export async function applyUserTurnToDurable(opts: ApplyUserTurnToDurableOpts): Promise<void> {
  const items = await extractFromUserTurn(opts.runtime, {
    userMessageText: opts.userMessageText,
    model: opts.model,
    cwd: opts.cwd,
  });

  if (items.length === 0) return;

  await durableWriteQueue.run(opts.userId, async () => {
    const store = (await loadDurableMemory(opts.durableDataDir, opts.userId)) ?? {
      version: 1 as const,
      updatedAt: 0,
      items: [],
    };

    for (const item of items) {
      addItem(store, item.text, { type: 'summary' }, opts.durableMaxItems, item.kind);
    }

    await saveDurableMemory(opts.durableDataDir, opts.userId, store);
  });
}
