import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadDurableMemory,
  saveDurableMemory,
  addItem,
  deprecateItems,
  selectItemsForInjection,
  formatDurableSection,
} from './durable-memory.js';
import type { DurableMemoryStore, DurableItem } from './durable-memory.js';
import { loadSummary } from './summarizer.js';
import { durableWriteQueue } from './durable-write-queue.js';

export type MemoryCommand = {
  action: 'show' | 'remember' | 'forget' | 'reset-rolling';
  args: string;
};

export function parseMemoryCommand(content: string): MemoryCommand | null {
  const trimmed = content.trim();
  if (!/^!memory(?:\s|$)/.test(trimmed)) return null;

  const rest = trimmed.slice('!memory'.length).trim();
  if (!rest || rest === 'show') return { action: 'show', args: '' };
  if (rest.startsWith('remember ')) return { action: 'remember', args: rest.slice('remember '.length).trim() };
  if (rest.startsWith('forget ')) return { action: 'forget', args: rest.slice('forget '.length).trim() };
  if (rest === 'reset rolling') return { action: 'reset-rolling', args: '' };

  return null;
}

export type HandleMemoryCommandOpts = {
  userId: string;
  sessionKey: string;
  durableDataDir: string;
  durableMaxItems: number;
  durableInjectMaxChars: number;
  summaryDataDir: string;
  channelId?: string;
  messageId?: string;
  guildId?: string;
  channelName?: string;
};

export async function handleMemoryCommand(
  cmd: MemoryCommand,
  opts: HandleMemoryCommandOpts,
): Promise<string> {
  try {
    if (cmd.action === 'show') {
      const store = await loadDurableMemory(opts.durableDataDir, opts.userId);
      const items = store
        ? selectItemsForInjection(store, opts.durableInjectMaxChars)
        : [];
      const durableText = items.length > 0
        ? formatDurableSection(items)
        : '(none)';

      let summaryText = '(none)';
      try {
        const summary = await loadSummary(opts.summaryDataDir, opts.sessionKey);
        if (summary) summaryText = summary.summary;
      } catch {
        // best-effort
      }

      return `**Durable memory:**\n${durableText}\n\n**Rolling summary:**\n${summaryText}`;
    }

    if (cmd.action === 'remember') {
      return durableWriteQueue.run(opts.userId, async () => {
        const store = await loadOrCreate(opts.durableDataDir, opts.userId);
        const source: DurableItem['source'] = { type: 'manual' };
        if (opts.channelId) source.channelId = opts.channelId;
        if (opts.messageId) source.messageId = opts.messageId;
        if (opts.guildId) source.guildId = opts.guildId;
        if (opts.channelName) source.channelName = opts.channelName;
        addItem(store, cmd.args, source, opts.durableMaxItems);
        await saveDurableMemory(opts.durableDataDir, opts.userId, store);
        return `Remembered: ${cmd.args}`;
      });
    }

    if (cmd.action === 'forget') {
      return durableWriteQueue.run(opts.userId, async () => {
        const store = await loadOrCreate(opts.durableDataDir, opts.userId);
        const { deprecatedCount } = deprecateItems(store, cmd.args);
        if (deprecatedCount > 0) {
          await saveDurableMemory(opts.durableDataDir, opts.userId, store);
          return `Forgot ${deprecatedCount} item(s).`;
        }
        return 'No matching items found.';
      });
    }

    if (cmd.action === 'reset-rolling') {
      const safeName = opts.sessionKey.replace(/[^a-zA-Z0-9:_-]+/g, '-');
      const filePath = path.join(opts.summaryDataDir, `${safeName}.json`);
      await fs.rm(filePath, { force: true });
      return 'Rolling summary cleared for this session.';
    }

    return 'Unknown memory command.';
  } catch (err) {
    return `Memory command error: ${String(err)}`;
  }
}

async function loadOrCreate(dir: string, userId: string): Promise<DurableMemoryStore> {
  const store = await loadDurableMemory(dir, userId);
  return store ?? { version: 1, updatedAt: 0, items: [] };
}
