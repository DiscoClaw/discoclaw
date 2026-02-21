import type { RuntimeAdapter } from '../runtime/types.js';
import type { DurableItem } from './durable-memory.js';
import { loadDurableMemory, saveDurableMemory, addItem } from './durable-memory.js';
import { durableWriteQueue } from './durable-write-queue.js';
import { extractFirstJsonValue } from './json-extract.js';

const VALID_KINDS = new Set<DurableItem['kind']>([
  'preference', 'fact', 'project', 'constraint', 'person', 'tool', 'workflow',
]);

export const EXTRACTION_PROMPT = `You are a long-term memory extractor. Given a user message, decide whether it contains anything worth remembering permanently, and if so extract up to 3 items.

## One-month test
Only extract something if it would still be useful to know in a month. Most messages contain nothing worth storing — return [] liberally.

## KEEP — stable, lasting facts
- User preferences and opinions (editor, language, style, communication preferences)
- Personal facts (name, location, timezone, family, pets, hobbies, job title)
- Stable project context (project names, tech stacks, team structure, architecture decisions)
- Cross-session conventions and workflows (branching strategy, deploy process, naming conventions)
- Relationships between people, teams, or projects

## EXCLUDE — transient task state
- Current bugs being fixed, PRs in flight, features being built right now
- One-time setup steps or installation instructions
- Transient decisions that will resolve within days
- Specific code line numbers, file paths, commit hashes, or error messages
- Anything that reads like a status update rather than a lasting fact
- In-progress test gaps or TODO items
- Summaries of what was just done in the current session

## Output format
Return a JSON array of objects with "kind" and "text" fields. Valid kinds: preference, fact, project, constraint, person, tool, workflow. Max 3 items. If nothing passes the one-month test, return [].

Only extract information the user explicitly stated.

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
    const jsonArray = extractFirstJsonValue(raw, { arrayOnly: true });
    if (!jsonArray) return [];
    const parsed = JSON.parse(jsonArray);
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
  channelId?: string;
  messageId?: string;
  guildId?: string;
  channelName?: string;
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
      const source: DurableItem['source'] = { type: 'summary' };
      if (opts.channelId) source.channelId = opts.channelId;
      if (opts.messageId) source.messageId = opts.messageId;
      if (opts.guildId) source.guildId = opts.guildId;
      if (opts.channelName) source.channelName = opts.channelName;
      addItem(store, item.text, { ...source }, opts.durableMaxItems, item.kind);
    }

    await saveDurableMemory(opts.durableDataDir, opts.userId, store);
  });
}
