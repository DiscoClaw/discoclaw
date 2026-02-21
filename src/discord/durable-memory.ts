import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export type DurableItem = {
  id: string;
  kind: 'preference' | 'fact' | 'project' | 'constraint' | 'person' | 'tool' | 'workflow';
  text: string;
  tags: string[];
  status: 'active' | 'deprecated';
  source: { type: 'discord' | 'manual' | 'summary'; channelId?: string; messageId?: string; guildId?: string; channelName?: string };
  createdAt: number;
  updatedAt: number;
};

export type DurableMemoryStore = {
  version: 1;
  updatedAt: number;
  items: DurableItem[];
};

function safeUserId(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error(`Invalid userId for durable memory path: ${userId}`);
  }
  return userId;
}

export async function loadDurableMemory(
  dir: string,
  userId: string,
): Promise<DurableMemoryStore | null> {
  const filePath = path.join(dir, `${safeUserId(userId)}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      'items' in parsed &&
      Array.isArray((parsed as any).items)
    ) {
      return parsed as DurableMemoryStore;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveDurableMemory(
  dir: string,
  userId: string,
  store: DurableMemoryStore,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeUserId(userId)}.json`);
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

export function deriveItemId(kind: DurableItem['kind'], text: string): string {
  const normalized = kind + ':' + text.trim().toLowerCase().replace(/\s+/g, ' ');
  return 'durable-' + crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

export function addItem(
  store: DurableMemoryStore,
  text: string,
  source: DurableItem['source'],
  maxItems: number,
  kind: DurableItem['kind'] = 'fact',
): DurableMemoryStore {
  const now = Date.now();
  const id = deriveItemId(kind, text);

  const existing = store.items.find((item) => item.id === id && item.status === 'active');
  if (existing) {
    existing.kind = kind;
    existing.text = text;
    existing.source = source;
    existing.updatedAt = now;
    store.updatedAt = now;
    return store;
  }

  const item: DurableItem = {
    id,
    kind,
    text,
    tags: [],
    status: 'active',
    source,
    createdAt: now,
    updatedAt: now,
  };
  store.items.push(item);
  store.updatedAt = now;

  // Enforce maxItems cap.
  while (store.items.length > maxItems) {
    // Drop oldest deprecated first.
    const deprecatedIdx = store.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.status === 'deprecated')
      .sort((a, b) => a.it.updatedAt - b.it.updatedAt)[0];

    if (deprecatedIdx) {
      store.items.splice(deprecatedIdx.i, 1);
    } else {
      // Drop oldest active.
      const activeIdx = store.items
        .map((it, i) => ({ it, i }))
        .filter(({ it }) => it.status === 'active')
        .sort((a, b) => a.it.updatedAt - b.it.updatedAt)[0];
      if (activeIdx) {
        store.items.splice(activeIdx.i, 1);
      } else {
        break;
      }
    }
  }

  return store;
}

export function deprecateItems(
  store: DurableMemoryStore,
  substring: string,
): { store: DurableMemoryStore; deprecatedCount: number } {
  const now = Date.now();
  const needle = substring.toLowerCase();
  let deprecatedCount = 0;

  for (const item of store.items) {
    if (item.status !== 'active') continue;
    // Match if substring covers >= 60% of item's text length.
    const textLower = item.text.toLowerCase();
    if (textLower.includes(needle) && needle.length >= item.text.length * 0.6) {
      item.status = 'deprecated';
      item.updatedAt = now;
      deprecatedCount++;
    }
  }

  if (deprecatedCount > 0) store.updatedAt = now;
  return { store, deprecatedCount };
}

export function selectItemsForInjection(
  store: DurableMemoryStore,
  maxChars: number,
): DurableItem[] {
  const active = store.items
    .filter((item) => item.status === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const selected: DurableItem[] = [];
  let chars = 0;
  for (const item of active) {
    const lineLen = formatItemLine(item).length;
    const sep = selected.length > 0 ? 1 : 0; // \n between items
    if (chars + sep + lineLen > maxChars) continue;
    selected.push(item);
    chars += sep + lineLen;
  }
  return selected;
}

function formatItemLine(item: DurableItem): string {
  const date = new Date(item.updatedAt).toISOString().slice(0, 10);
  const ch = item.source.channelName ? `, #${item.source.channelName}` : '';
  return `- [${item.kind}] ${item.text} (src: ${item.source.type}${ch}, updated ${date})`;
}

export function formatDurableSection(items: DurableItem[]): string {
  return items.map(formatItemLine).join('\n');
}
