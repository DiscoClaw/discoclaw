import fs from 'node:fs/promises';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import type { Guild } from 'discord.js';
import { KeyedQueue } from '../group-queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShortTermEntry = {
  timestamp: number;
  sessionKey: string;
  channelId?: string;
  channelName: string;
  summary: string;
};

export type ShortTermStore = {
  version: 1;
  entries: ShortTermEntry[];
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function safeGuildUserId(guildUserId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(guildUserId)) {
    throw new Error(`Invalid guildUserId for short-term memory path: ${guildUserId}`);
  }
  return guildUserId;
}

export async function loadShortTermMemory(
  dir: string,
  guildUserId: string,
): Promise<ShortTermStore | null> {
  const filePath = path.join(dir, `${safeGuildUserId(guildUserId)}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      'entries' in parsed &&
      Array.isArray((parsed as any).entries)
    ) {
      return parsed as ShortTermStore;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveShortTermMemory(
  dir: string,
  guildUserId: string,
  store: ShortTermStore,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeGuildUserId(guildUserId)}.json`);
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Write queue (per guild-user key)
// ---------------------------------------------------------------------------

const shortTermWriteQueue = new KeyedQueue();

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function appendEntry(
  dir: string,
  guildUserId: string,
  entry: ShortTermEntry,
  opts: { maxEntries: number; maxAgeMs: number },
): Promise<void> {
  await shortTermWriteQueue.run(guildUserId, async () => {
    const store = (await loadShortTermMemory(dir, guildUserId)) ?? {
      version: 1 as const,
      entries: [],
    };

    store.entries.push(entry);

    // Prune: remove expired entries and enforce cap.
    const now = Date.now();
    store.entries = store.entries
      .filter((e) => now - e.timestamp < opts.maxAgeMs)
      .slice(-opts.maxEntries);

    await saveShortTermMemory(dir, guildUserId, store);
  });
}

export function buildExcerptSummary(
  userMsg: string,
  botResponse: string,
  maxLen: number = 200,
): string {
  const userPart = userMsg.slice(0, Math.floor(maxLen / 2)).trim();
  const botPart = botResponse.slice(0, Math.floor(maxLen / 2)).trim();
  return `User: ${userPart} | Bot: ${botPart}`;
}

export function selectEntriesForInjection(
  store: ShortTermStore,
  maxChars: number,
  maxAgeMs: number,
): ShortTermEntry[] {
  const now = Date.now();
  const recent = store.entries
    .filter((e) => now - e.timestamp < maxAgeMs)
    .sort((a, b) => b.timestamp - a.timestamp);

  const selected: ShortTermEntry[] = [];
  let chars = 0;
  for (const entry of recent) {
    const line = formatEntryLine(entry);
    const sep = selected.length > 0 ? 1 : 0;
    if (chars + sep + line.length > maxChars) continue;
    selected.push(entry);
    chars += sep + line.length;
  }
  return selected;
}

function formatEntryLine(entry: ShortTermEntry): string {
  const ago = formatTimeAgo(Date.now() - entry.timestamp);
  return `- ${ago} in #${entry.channelName}: ${entry.summary}`;
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${hours > 1 ? 's' : ''} ago`;
}

export function formatShortTermSection(entries: ShortTermEntry[]): string {
  return entries.map(formatEntryLine).join('\n');
}

// ---------------------------------------------------------------------------
// Channel privacy check
// ---------------------------------------------------------------------------

export function isChannelPublic(channel: any, guild: Guild): boolean {
  // DMs have no guild — always skip.
  if (!guild) return false;

  // Category / voice channels — skip.
  const type = channel?.type;
  if (type === undefined || type === null) return false;

  // Check if it's a thread (public or private) or forum post.
  const isThread = typeof channel.isThread === 'function' ? channel.isThread() : false;

  if (isThread) {
    // Inherit parent channel visibility.
    const parent = channel.parent;
    if (!parent) return false;
    return checkEveryoneViewChannel(parent, guild);
  }

  return checkEveryoneViewChannel(channel, guild);
}

function checkEveryoneViewChannel(channel: any, guild: Guild): boolean {
  try {
    const everyone = guild.roles.everyone;
    if (!everyone) return false;
    const perms = channel.permissionsFor?.(everyone);
    if (!perms) return false;
    return perms.has(PermissionFlagsBits.ViewChannel);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Prompt section builder
// ---------------------------------------------------------------------------

export async function buildShortTermMemorySection(opts: {
  enabled: boolean;
  shortTermDataDir: string;
  guildId: string;
  userId: string;
  maxChars: number;
  maxAgeMs: number;
  log?: { warn(obj: any, msg?: string): void };
}): Promise<string> {
  if (!opts.enabled) return '';
  if (!opts.guildId) return '';

  try {
    const guildUserId = `${opts.guildId}-${opts.userId}`;
    const store = await loadShortTermMemory(opts.shortTermDataDir, guildUserId);
    if (!store) return '';

    const entries = selectEntriesForInjection(store, opts.maxChars, opts.maxAgeMs);
    if (entries.length === 0) return '';

    return formatShortTermSection(entries);
  } catch (err) {
    opts.log?.warn({ err, userId: opts.userId }, 'short-term memory load failed');
    return '';
  }
}
