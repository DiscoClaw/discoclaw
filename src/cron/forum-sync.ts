import { ChannelType, EmbedBuilder } from 'discord.js';
import type { Client, ForumChannel, AnyThreadChannel, Message } from 'discord.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { CronScheduler } from './scheduler.js';
import { parseCronDefinition } from './parser.js';
import type { ParsedCronDef } from './types.js';
import type { CronRunStats } from './run-stats.js';
import { generateCronId, parseCronIdFromContent } from './run-stats.js';
import { detectCadence } from './cadence.js';
import { ensureStatusMessage } from './discord-sync.js';

export type ForumSyncOptions = {
  client: Client;
  forumChannelNameOrId: string;
  // Authorization: only these users may create/update cron jobs via the cron forum.
  allowUserIds: Set<string>;
  scheduler: CronScheduler;
  runtime: RuntimeAdapter;
  cronModel: string;
  cwd: string;
  log?: LoggerLike;
  // Optional: persistent stats store for cronId recovery and status messages.
  statsStore?: CronRunStats;
  // Thread IDs currently being created by cronCreate action. Checked by the
  // threadCreate listener to avoid double-handling before register() completes.
  pendingThreadIds?: Set<string>;
  onCountChanged?: () => void;
};

function resolveForumChannel(client: Client, nameOrId: string): ForumChannel | null {
  // Try by ID first.
  const byId = client.channels.cache.get(nameOrId);
  if (byId && byId.type === ChannelType.GuildForum) return byId as ForumChannel;

  // Try by name across all guilds.
  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildForum && c.name === nameOrId,
    );
    if (ch) return ch as ForumChannel;
  }
  return null;
}

function isSnowflakeId(v: string): boolean {
  return /^\d+$/.test(String(v ?? '').trim());
}

async function fetchStarterMessage(thread: AnyThreadChannel): Promise<Message | null> {
  try {
    return await thread.fetchStarterMessage() ?? null;
  } catch {
    return null;
  }
}

function isBotOwned(thread: AnyThreadChannel): boolean {
  const botUserId = thread.client?.user?.id ?? '';
  return botUserId !== '' && thread.ownerId === botUserId;
}

async function rejectManualThread(
  thread: AnyThreadChannel,
  log?: LoggerLike,
): Promise<void> {
  log?.info({ threadId: thread.id, name: thread.name, ownerId: thread.ownerId }, 'cron:forum rejected manual thread');
  try {
    await thread.send(
      'Cron jobs must be created using the `cronCreate` bot command, not by manually creating forum threads.\n\n'
      + 'Ask the bot to create a cron job for you, and it will set up this forum thread automatically.\n\n'
      + 'This thread will be archived.',
    );
  } catch { /* ignore */ }
  try {
    await thread.setArchived(true);
  } catch { /* ignore */ }
}

function scheduleEmbed(name: string, def: ParsedCronDef, nextRun: Date | null): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`Cron Registered: ${name}`)
    .addFields(
      { name: 'Schedule', value: `\`${def.schedule}\``, inline: true },
      { name: 'Timezone', value: def.timezone, inline: true },
      { name: 'Channel', value: `#${def.channel}`, inline: true },
      { name: 'Prompt', value: def.prompt.slice(0, 1024) },
      { name: 'Next Run', value: nextRun ? `<t:${Math.floor(nextRun.getTime() / 1000)}:F>` : 'N/A', inline: true },
    )
    .setTimestamp();
}

async function recoverCronId(
  thread: AnyThreadChannel,
  statsStore: CronRunStats | undefined,
  log?: LoggerLike,
): Promise<string | null> {
  // 1. Check stats store by threadId.
  if (statsStore) {
    const record = statsStore.getRecordByThreadId(thread.id);
    if (record) return record.cronId;
  }

  // 2. Look for bot status messages and recover by metadata index first.
  // Keep content-token parse as legacy fallback.
  try {
    const messages = await thread.messages.fetch({ limit: 20 });
    for (const msg of messages.values()) {
      if (!msg.author.bot) continue;
      if (statsStore) {
        const byStatusMessage = statsStore.getRecordByStatusMessageId(msg.id);
        if (byStatusMessage && byStatusMessage.threadId === thread.id) {
          return byStatusMessage.cronId;
        }
      }
      const cronId = parseCronIdFromContent(msg.content);
      if (cronId) return cronId;
    }
  } catch {
    // Ignore fetch failures.
  }

  return null;
}

async function loadThreadAsCron(
  thread: AnyThreadChannel,
  guildId: string,
  scheduler: CronScheduler,
  runtime: RuntimeAdapter,
  opts: { cronModel: string; cwd: string; log?: LoggerLike; isNew: boolean; allowUserIds: Set<string>; statsStore?: CronRunStats },
): Promise<boolean> {
  const starter = await fetchStarterMessage(thread);
  if (!starter?.content) {
    opts.log?.warn({ threadId: thread.id, name: thread.name }, 'cron:forum no starter message');
    return false;
  }

  const starterAuthorId = (starter as any)?.author?.id ? String((starter as any).author.id) : '';
  const botUserId = thread.client?.user?.id ?? '';
  // SECURITY: Bot-authored threads are accepted because cronCreate (the only
  // code path that creates bot-authored threads in the cron forum) already
  // requires the requesting user to be in the Discord allowlist. If another
  // code path ever creates bot-authored cron forum threads, it must enforce
  // its own authorization check.
  const isBotAuthored = botUserId !== '' && starterAuthorId === botUserId;
  if (!starterAuthorId || (!opts.allowUserIds.has(starterAuthorId) && !isBotAuthored)) {
    opts.log?.warn({ threadId: thread.id, name: thread.name, starterAuthorId }, 'cron:forum starter author not allowlisted');
    scheduler.disable(thread.id);
    try {
      await thread.send('Cron not registered: the starter message author is not allowlisted for cron.');
    } catch {
      // Ignore send failures.
    }
    return false;
  }

  const def = await parseCronDefinition(starter.content, runtime, { model: opts.cronModel, cwd: opts.cwd });
  if (!def) {
    opts.log?.warn({ threadId: thread.id, name: thread.name }, 'cron:forum parse failed');
    scheduler.disable(thread.id);
    try {
      await thread.send('Could not parse this cron definition. Please edit the starter message with a clearer schedule, timezone, target channel, and instruction.');
    } catch {
      // Ignore send failures.
    }
    return false;
  }

  // Resolve or mint a stable cronId.
  let cronId = await recoverCronId(thread, opts.statsStore, opts.log);
  if (!cronId) {
    cronId = generateCronId();
    opts.log?.info({ threadId: thread.id, cronId }, 'cron:forum minted new cronId');
  }

  let job;
  try {
    job = scheduler.register(thread.id, thread.id, guildId, thread.name, def, cronId);
  } catch (err) {
    opts.log?.error({ err, threadId: thread.id, schedule: def.schedule }, 'cron:forum invalid schedule');
    scheduler.disable(thread.id);
    try {
      await thread.send(`Invalid cron schedule: \`${def.schedule}\`. Please edit the starter message with a valid schedule.`);
    } catch {
      // Ignore send failures.
    }
    return false;
  }

  // Ensure stats record exists and set cadence.
  if (opts.statsStore) {
    try {
      const cadence = detectCadence(def.schedule ?? '');
      const existingRecord = opts.statsStore.getRecord(cronId);
      await opts.statsStore.upsertRecord(cronId, thread.id, {
        cadence,
        // Preserve existing disabled state.
        disabled: existingRecord?.disabled ?? false,
      });

      // Restore disabled state from stats.
      if (existingRecord?.disabled) {
        scheduler.disable(thread.id);
        opts.log?.info({ threadId: thread.id, cronId }, 'cron:forum restored disabled state');
      }
    } catch (err) {
      opts.log?.warn({ err, threadId: thread.id }, 'cron:forum stats upsert failed');
    }
  }

  // Only post confirmation on first registration (not re-parses) to keep threads clean.
  if (opts.isNew) {
    try {
      await starter.react('\u2705');
    } catch {
      // Ignore reaction failures.
    }
    try {
      const nextRun = job.cron?.nextRun() ?? null;
      await thread.send({ embeds: [scheduleEmbed(thread.name, def, nextRun)] });
    } catch {
      // Ignore send failures.
    }

    // Create initial status message for new threads.
    if (opts.statsStore) {
      try {
        const record = opts.statsStore.getRecord(cronId);
        if (record) {
          await ensureStatusMessage(thread.client, thread.id, cronId, record, opts.statsStore, { log: opts.log });
        }
      } catch {
        // Best-effort.
      }
    }
  }

  return true;
}

export async function initCronForum(opts: ForumSyncOptions): Promise<{ forumId: string }> {
  const { client, forumChannelNameOrId, allowUserIds, scheduler, runtime, cronModel, cwd, log, statsStore, pendingThreadIds } = opts;

  if (!isSnowflakeId(forumChannelNameOrId)) {
    log?.warn({ forumChannelNameOrId }, 'cron:forum name-based resolution is ambiguous; prefer a channel ID');
  }

  const forum = resolveForumChannel(client, forumChannelNameOrId);
  if (!forum) {
    log?.warn({ forumChannelNameOrId }, 'cron:forum channel not found, cron subsystem disabled');
    return { forumId: '' };
  }

  log?.info({ forumId: forum.id, name: forum.name }, 'cron:forum resolved');
  const guildId = forum.guildId;

  // --- Initial load: fetch all active threads ---
  const { threads: activeThreads } = await forum.threads.fetchActive();
  let loaded = 0;
  for (const thread of activeThreads.values()) {
    if (thread.archived) continue;
    const ok = await loadThreadAsCron(thread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: false, allowUserIds, statsStore });
    if (ok) loaded++;
  }
  log?.info({ loaded, total: activeThreads.size }, 'cron:forum initial load complete');

  // --- Live event listeners ---
  const forumId = forum.id;
  const reparseTimers = new Map<string, NodeJS.Timeout>();
  const scheduleReparse = (thread: AnyThreadChannel, isNew: boolean) => {
    const key = String(thread.id ?? '');
    const existing = reparseTimers.get(key);
    if (existing) clearTimeout(existing);
    reparseTimers.set(key, setTimeout(() => {
      reparseTimers.delete(key);
      void (async () => {
        try {
          await loadThreadAsCron(thread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew, allowUserIds, statsStore });
        } catch (err) {
          log?.error?.({ err, threadId: key }, 'cron:forum reparse failed');
        }
      })();
    }, 1000));
  };

  client.on('threadCreate', async (thread: AnyThreadChannel) => {
    try {
      if (thread.parentId !== forumId) return;

      // Skip threads created by cronCreate action to avoid double-handling.
      // Check both the scheduler (already registered) and the pending set
      // (registered soon — covers the window between threads.create and
      // scheduler.register in the cronCreate flow).
      if (scheduler.getJob(thread.id) || pendingThreadIds?.has(thread.id)) {
        log?.info({ threadId: thread.id, name: thread.name }, 'cron:forum threadCreate skipped (already registered or pending)');
        return;
      }

      // Reject manually-created threads (not created by the bot).
      if (!isBotOwned(thread)) {
        await rejectManualThread(thread, log);
        return;
      }

      log?.info({ threadId: thread.id, name: thread.name }, 'cron:forum threadCreate');
      // Small delay: Discord may not have the starter message ready immediately after thread creation.
      await new Promise((r) => setTimeout(r, 2000));
      const ok = await loadThreadAsCron(thread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: true, allowUserIds, statsStore });
      if (ok) opts.onCountChanged?.();
    } catch (err) {
      log?.error({ err, threadId: thread.id }, 'cron:forum threadCreate handler failed');
    }
  });

  client.on('threadDelete', (thread: AnyThreadChannel) => {
    try {
      if (thread.parentId !== forumId) return;
      log?.info({ threadId: thread.id, name: thread.name }, 'cron:forum threadDelete');
      scheduler.unregister(thread.id);
      opts.onCountChanged?.();
      // Clean up stats.
      if (statsStore) {
        void statsStore.removeByThreadId(thread.id).catch(() => {});
      }
    } catch (err) {
      log?.error({ err, threadId: thread.id }, 'cron:forum threadDelete handler failed');
    }
  });

  client.on('threadUpdate', async (oldThread: AnyThreadChannel, newThread: AnyThreadChannel) => {
    try {
      if (newThread.parentId !== forumId) return;

      // Archive state changed.
      if (oldThread.archived !== newThread.archived) {
        if (newThread.archived) {
          log?.info({ threadId: newThread.id }, 'cron:forum thread archived, disabling');
          scheduler.disable(newThread.id);
          // Persist disabled state.
          if (statsStore) {
            const record = statsStore.getRecordByThreadId(newThread.id);
            if (record) {
              void statsStore.upsertRecord(record.cronId, newThread.id, { disabled: true }).catch(() => {});
            }
          }
        } else {
          // Reject unarchived manual threads not already grandfathered into the scheduler.
          if (!scheduler.getJob(newThread.id) && !isBotOwned(newThread)) {
            await rejectManualThread(newThread, log);
            return;
          }
          log?.info({ threadId: newThread.id }, 'cron:forum thread unarchived, re-loading');
          await loadThreadAsCron(newThread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: false, allowUserIds, statsStore });
        }
        return;
      }

      // Name changed — update the job name (re-parse for good measure).
      if (oldThread.name !== newThread.name) {
        // Reject manual threads not already in the scheduler.
        if (!scheduler.getJob(newThread.id) && !isBotOwned(newThread)) {
          await rejectManualThread(newThread, log);
          return;
        }
        log?.info({ threadId: newThread.id, oldName: oldThread.name, newName: newThread.name }, 'cron:forum thread name changed');
        await loadThreadAsCron(newThread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: false, allowUserIds, statsStore });
      }
    } catch (err) {
      log?.error({ err, threadId: newThread.id }, 'cron:forum threadUpdate handler failed');
    }
  });

  client.on('messageUpdate', async (_oldMsg: any, newMsg: any) => {
    try {
      // Check if this is the starter message of a tracked cron thread.
      if (!newMsg?.channel || !newMsg?.id) return;
      const thread = newMsg.channel;
      if (thread.parentId !== forumId) return;

      // Verify it's the starter message (first message in thread).
      try {
        const starter = await thread.fetchStarterMessage();
        if (starter?.id !== newMsg.id) return;
      } catch {
        return;
      }

      log?.info({ threadId: thread.id, name: thread.name }, 'cron:forum starter message updated, re-parsing');
      scheduleReparse(thread, false);
    } catch (err) {
      log?.error({ err }, 'cron:forum messageUpdate handler failed');
    }
  });

  return { forumId };
}
