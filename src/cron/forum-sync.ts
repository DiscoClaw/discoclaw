import { ChannelType, EmbedBuilder } from 'discord.js';
import type { Client, ForumChannel, AnyThreadChannel, Message } from 'discord.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { LoggerLike } from '../discord/action-types.js';
import { CronScheduler } from './scheduler.js';
import { parseCronDefinition } from './parser.js';
import type { ParsedCronDef } from './types.js';

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

async function loadThreadAsCron(
  thread: AnyThreadChannel,
  guildId: string,
  scheduler: CronScheduler,
  runtime: RuntimeAdapter,
  opts: { cronModel: string; cwd: string; log?: LoggerLike; isNew: boolean; allowUserIds: Set<string> },
): Promise<boolean> {
  const starter = await fetchStarterMessage(thread);
  if (!starter?.content) {
    opts.log?.warn({ threadId: thread.id, name: thread.name }, 'cron:forum no starter message');
    return false;
  }

  const starterAuthorId = (starter as any)?.author?.id ? String((starter as any).author.id) : '';
  if (!starterAuthorId || !opts.allowUserIds.has(starterAuthorId)) {
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

  let job;
  try {
    job = scheduler.register(thread.id, thread.id, guildId, thread.name, def);
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
  }

  return true;
}

export async function initCronForum(opts: ForumSyncOptions): Promise<{ forumId: string }> {
  const { client, forumChannelNameOrId, allowUserIds, scheduler, runtime, cronModel, cwd, log } = opts;

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
    const ok = await loadThreadAsCron(thread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: false, allowUserIds });
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
          await loadThreadAsCron(thread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew, allowUserIds });
        } catch (err) {
          log?.error?.({ err, threadId: key }, 'cron:forum reparse failed');
        }
      })();
    }, 1000));
  };

  client.on('threadCreate', async (thread: AnyThreadChannel) => {
    try {
      if (thread.parentId !== forumId) return;
      log?.info({ threadId: thread.id, name: thread.name }, 'cron:forum threadCreate');
      // Small delay: Discord may not have the starter message ready immediately after thread creation.
      await new Promise((r) => setTimeout(r, 2000));
      await loadThreadAsCron(thread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: true, allowUserIds });
    } catch (err) {
      log?.error({ err, threadId: thread.id }, 'cron:forum threadCreate handler failed');
    }
  });

  client.on('threadDelete', (thread: AnyThreadChannel) => {
    try {
      if (thread.parentId !== forumId) return;
      log?.info({ threadId: thread.id, name: thread.name }, 'cron:forum threadDelete');
      scheduler.unregister(thread.id);
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
        } else {
          log?.info({ threadId: newThread.id }, 'cron:forum thread unarchived, re-loading');
          await loadThreadAsCron(newThread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: false, allowUserIds });
        }
        return;
      }

      // Name changed — update the job name (re-parse for good measure).
      if (oldThread.name !== newThread.name) {
        log?.info({ threadId: newThread.id, oldName: oldThread.name, newName: newThread.name }, 'cron:forum thread name changed');
        await loadThreadAsCron(newThread, guildId, scheduler, runtime, { cronModel, cwd, log, isNew: false, allowUserIds });
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
