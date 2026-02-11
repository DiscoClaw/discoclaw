import fs from 'node:fs/promises';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import type { Client, ForumChannel, ThreadChannel } from 'discord.js';
import type { CronRunRecord, CronRunStats, CadenceTag } from './run-stats.js';
import type { LoggerLike } from '../discord/action-types.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type TagMap = Record<string, string>;

// ---------------------------------------------------------------------------
// Forum channel resolution
// ---------------------------------------------------------------------------

export async function resolveForumChannel(client: Client, forumId: string): Promise<ForumChannel | null> {
  const ch = client.channels.cache.get(forumId);
  if (ch && ch.type === ChannelType.GuildForum) return ch as ForumChannel;
  try {
    const fetched = await client.channels.fetch(forumId);
    if (fetched && fetched.type === ChannelType.GuildForum) return fetched as ForumChannel;
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Cadence emojis
// ---------------------------------------------------------------------------

export const CADENCE_EMOJI: Record<string, string> = {
  frequent: '\u23F1',  // ⏱
  hourly: '\uD83D\uDD50',    // 🕐
  daily: '\uD83C\uDF05',     // 🌅
  weekly: '\uD83D\uDCC5',    // 📅
  monthly: '\uD83D\uDCC6',   // 📆
};

// ---------------------------------------------------------------------------
// Thread name builder
// ---------------------------------------------------------------------------

const THREAD_NAME_MAX = 100;

export function buildCronThreadName(name: string, cadence: CadenceTag | null): string {
  const emoji = cadence ? (CADENCE_EMOJI[cadence] ?? '') : '';
  const prefix = emoji ? `${emoji} ` : '';
  const maxName = THREAD_NAME_MAX - prefix.length;
  const trimmed = name.length > maxName ? name.slice(0, maxName - 1) + '\u2026' : name;
  return `${prefix}${trimmed}`;
}

// ---------------------------------------------------------------------------
// Status message formatting
// ---------------------------------------------------------------------------

export function formatStatusMessage(cronId: string, record: CronRunRecord): string {
  const lines: string[] = [];
  lines.push(`\uD83D\uDCCA **Cron Status** [cronId:${cronId}]`);

  const lastRun = record.lastRunAt
    ? `<t:${Math.floor(new Date(record.lastRunAt).getTime() / 1000)}:R>`
    : 'Never';
  const statusEmoji = record.lastRunStatus === 'success' ? '\u2705' : record.lastRunStatus === 'error' ? '\u274C' : '\u2796';
  const statusText = record.lastRunStatus ?? 'N/A';
  lines.push(`**Last run:** ${lastRun} | **Status:** ${statusEmoji} ${statusText} | **Runs:** ${record.runCount}`);

  const model = record.modelOverride ?? record.model ?? 'N/A';
  const cadence = record.cadence ?? 'N/A';
  lines.push(`**Model:** ${model} | **Cadence:** ${cadence}`);

  if (record.purposeTags.length > 0) {
    lines.push(`**Tags:** ${record.purposeTags.join(', ')}`);
  }

  if (record.lastRunStatus === 'error' && record.lastErrorMessage) {
    lines.push(`**Last error:** ${record.lastErrorMessage}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Status message lifecycle
// ---------------------------------------------------------------------------

async function fetchThreadChannel(client: Client, threadId: string): Promise<ThreadChannel | null> {
  const cached = client.channels.cache.get(threadId);
  if (cached && cached.isThread()) return cached as ThreadChannel;
  try {
    const fetched = await client.channels.fetch(threadId);
    if (fetched && fetched.isThread()) return fetched as ThreadChannel;
    return null;
  } catch {
    return null;
  }
}

export async function ensureStatusMessage(
  client: Client,
  threadId: string,
  cronId: string,
  record: CronRunRecord,
  stats: CronRunStats,
  log?: LoggerLike,
): Promise<string | undefined> {
  const thread = await fetchThreadChannel(client, threadId);
  if (!thread) {
    log?.warn({ threadId, cronId }, 'cron:status-msg thread not found');
    return undefined;
  }

  const content = formatStatusMessage(cronId, record);

  // Try to edit existing status message.
  if (record.statusMessageId) {
    try {
      const msg = await thread.messages.fetch(record.statusMessageId);
      if (msg) {
        await msg.edit({ content, allowedMentions: { parse: [] } });
        return record.statusMessageId;
      }
    } catch {
      // Message may have been deleted; fall through to create.
    }
  }

  // Create new status message.
  try {
    const msg = await thread.send({ content, allowedMentions: { parse: [] } });

    // Best-effort pin.
    try {
      await msg.pin();
    } catch {
      // Non-fatal if pin fails.
    }

    // Store the message ID.
    await stats.upsertRecord(cronId, threadId, { statusMessageId: msg.id });
    return msg.id;
  } catch (err) {
    log?.warn({ err, threadId, cronId }, 'cron:status-msg creation failed');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tag map seeding
// ---------------------------------------------------------------------------

export async function seedTagMap(seedPath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return false; // Already exists.
  } catch {
    // Doesn't exist yet; seed it.
  }
  try {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(seedPath, targetPath);
    return true;
  } catch {
    return false;
  }
}
