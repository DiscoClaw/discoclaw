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
import {
  loadShortTermMemory,
  selectEntriesForInjection,
  formatShortTermSection,
} from './shortterm-memory.js';
import { estimateTokensFromChars } from './prompt-common.js';

export type MemoryCommand = {
  action: 'show' | 'remember' | 'forget' | 'reset-rolling';
  args: string;
};

export function parseMemoryCommand(content: string): MemoryCommand | null {
  const trimmed = content.trim();
  if (!/^!memory(?:\s|$)/.test(trimmed)) return null;

  const rest = trimmed.slice('!memory'.length).trim();
  if (!rest || rest === 'show') return { action: 'show', args: '' };
  if (rest.startsWith('remember ')) {
    const args = rest.slice('remember '.length).trim();
    if (!args) return null;
    return { action: 'remember', args };
  }
  if (rest.startsWith('forget ')) {
    const args = rest.slice('forget '.length).trim();
    if (!args) return null;
    return { action: 'forget', args };
  }
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
  /** Short-term memory data directory. Omit to skip short-term display. */
  shortTermDataDir?: string;
  /** Short-term memory injection budget in chars (default 1000). */
  shortTermInjectMaxChars?: number;
  /** Short-term memory max age in ms (default 6h). */
  shortTermMaxAgeMs?: number;
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
      const durableChars = items.length > 0 ? durableText.length : 0;

      let summaryText = '(none)';
      let summaryChars = 0;
      try {
        const summary = await loadSummary(opts.summaryDataDir, opts.sessionKey);
        if (summary) {
          summaryText = summary.summary;
          summaryChars = summaryText.length;
        }
      } catch {
        // best-effort
      }

      let shortTermText = '(none)';
      let shortTermChars = 0;
      if (opts.shortTermDataDir && opts.guildId) {
        try {
          const guildUserId = `${opts.guildId}-${opts.userId}`;
          const stStore = await loadShortTermMemory(opts.shortTermDataDir, guildUserId);
          if (stStore) {
            const maxChars = opts.shortTermInjectMaxChars ?? 1000;
            const maxAgeMs = opts.shortTermMaxAgeMs ?? 6 * 60 * 60 * 1000;
            const entries = selectEntriesForInjection(stStore, maxChars, maxAgeMs);
            if (entries.length > 0) {
              shortTermText = formatShortTermSection(entries);
              shortTermChars = shortTermText.length;
            }
          }
        } catch {
          // best-effort
        }
      }

      const totalChars = durableChars + summaryChars + shortTermChars;
      const totalTokens = estimateTokensFromChars(totalChars);

      const sections = [
        `**Durable memory:** (${durableChars} chars, ~${estimateTokensFromChars(durableChars)} tokens)\n${durableText}`,
        `**Rolling summary:** (${summaryChars} chars, ~${estimateTokensFromChars(summaryChars)} tokens)\n${summaryText}`,
        `**Short-term memory:** (${shortTermChars} chars, ~${estimateTokensFromChars(shortTermChars)} tokens)\n${shortTermText}`,
        `**Total prompt memory:** ${totalChars} chars, ~${totalTokens} tokens`,
      ];

      return sections.join('\n\n');
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
