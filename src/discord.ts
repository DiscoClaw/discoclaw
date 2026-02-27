import fs from 'node:fs/promises';
import { ActivityType, Client, GatewayIntentBits, Partials } from 'discord.js';
import type { Guild, PresenceData } from 'discord.js';
import { KeyedQueue } from './group-queue.js';
import type { LoggerLike } from './logging/logger-like.js';
import { ACTIVITY_TYPE_MAP } from './discord/actions-bot-profile.js';
import { createStatusPoster } from './discord/status-channel.js';
import { ensureSystemScaffold, selectBootstrapGuild } from './discord/system-bootstrap.js';
import type { SystemScaffold } from './discord/system-bootstrap.js';
import { createReactionAddHandler, createReactionRemoveHandler } from './discord/reaction-handler.js';
import { createMessageCreateHandler } from './discord/message-coordinator.js';
import type { BotParams, StatusRef } from './discord/message-coordinator.js';

export type { BotParams, StatusRef };
export type QueueLike = Pick<KeyedQueue, 'run'> & { size?: () => number };

export { createMessageCreateHandler };
export {
  ensureGroupDir,
  groupDirNameFromSessionKey,
  splitDiscord,
  truncateCodeBlocks,
  renderDiscordTail,
  renderActivityTail,
  formatBoldLabel,
  thinkingLabel,
  selectStreamingOutput,
  formatElapsed,
} from './discord/message-coordinator.js';

// ---------------------------------------------------------------------------
// Shared forge/plan state — delegated to forge-plan-registry.ts
// ---------------------------------------------------------------------------

import { getActiveForgeId as registryGetActiveForgeId } from './discord/forge-plan-registry.js';

/** Returns the active forge plan ID if a forge is running, undefined otherwise. */
export function getActiveForgeId(): string | undefined {
  return registryGetActiveForgeId();
}

function errorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

type GuildForNickname = {
  id: string;
  members: {
    me: { nickname: string | null; user?: { username: string }; setNickname(nick: string, reason?: string): Promise<unknown> } | null;
    fetchMe(): Promise<{ nickname: string | null; user?: { username: string }; setNickname(nick: string, reason?: string): Promise<unknown> }>;
  };
};

export async function setBotNickname(guild: GuildForNickname, nickname: string, log?: LoggerLike): Promise<void> {
  try {
    let me = guild.members?.me;
    if (!me) {
      try {
        me = await guild.members.fetchMe();
      } catch {
        log?.warn({ guildId: guild.id }, 'discord:nickname could not fetch bot member');
        return;
      }
    }
    // Skip if nickname already matches.
    if (me.nickname === nickname) return;
    // Skip if no nickname is set and the username already matches.
    if (me.nickname == null && me.user?.username === nickname) return;

    await me.setNickname(nickname, 'Automatic nickname from bot identity');
    log?.info({ guildId: guild.id, nickname }, 'discord:nickname set');
  } catch (err) {
    if (errorCode(err) === 50013) {
      log?.warn({ guildId: guild.id }, 'discord:nickname Missing Permissions — cannot set nickname');
    } else {
      log?.warn({ err, guildId: guild.id }, 'discord:nickname failed to set');
    }
  }
}

function resolveStatusChannel(client: Client, nameOrId: string, statusOpts: { botDisplayName?: string; log?: LoggerLike }): import('./discord/status-channel.js').StatusPoster | null {
  // Try by ID first, then by name across all guilds.
  const byId = client.channels.cache.get(nameOrId);
  if (byId?.isTextBased() && !byId.isDMBased()) return createStatusPoster(byId, statusOpts);

  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(
      (c) => c.isTextBased() && c.name === nameOrId,
    );
    if (ch && ch.isTextBased()) return createStatusPoster(ch, statusOpts);
  }
  return null;
}

async function resolveStatusChannelById(client: Client, channelId: string, statusOpts: { botDisplayName?: string; log?: LoggerLike }): Promise<import('./discord/status-channel.js').StatusPoster | null> {
  const cached = client.channels.cache.get(channelId);
  const ch = cached ?? await client.channels.fetch(channelId).catch(() => null);
  if (ch?.isTextBased() && !ch.isDMBased()) return createStatusPoster(ch, statusOpts);
  return null;
}

export async function startDiscordBot(params: BotParams): Promise<{ client: Client; status: import('./discord/status-channel.js').StatusPoster | null; system: SystemScaffold | null }> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      ...((params.reactionHandlerEnabled || params.reactionRemoveHandlerEnabled) ? [GatewayIntentBits.GuildMessageReactions] : []),
      ...(params.voiceEnabled ? [GatewayIntentBits.GuildVoiceStates] : []),
    ],
    partials: [
      Partials.Channel,
      ...((params.reactionHandlerEnabled || params.reactionRemoveHandlerEnabled) ? [Partials.Message, Partials.Reaction, Partials.User] : []),
    ],
  });

  // Mutable ref: handler captures this at registration time, but dereferences
  // .current at call time so we can set it after the ready event.
  const statusRef: StatusRef = { current: null };

  const queue = new KeyedQueue();
  client.on('messageCreate', createMessageCreateHandler(params, queue, statusRef));

  if (params.reactionHandlerEnabled) {
    client.on('messageReactionAdd', createReactionAddHandler(params, queue, statusRef));
  }

  if (params.reactionRemoveHandlerEnabled) {
    client.on('messageReactionRemove', createReactionRemoveHandler(params, queue, statusRef));
  }

  if (params.autoJoinThreads) {
    client.on('threadCreate', async (thread) => {
      const joinable = typeof thread?.joinable === 'boolean' ? thread.joinable : true;
      const joined = typeof thread?.joined === 'boolean' ? thread.joined : false;
      if (!joinable || joined || typeof thread?.join !== 'function') return;
      try {
        await thread.join();
        params.log?.info(
          { threadId: String(thread.id ?? ''), parentId: String(thread.parentId ?? '') },
          'discord:thread joined (threadCreate)',
        );
      } catch (err) {
        params.log?.warn({ err, threadId: String(thread?.id ?? '') }, 'discord:thread failed to join (threadCreate)');
      }
    });
  }

  client.on('guildCreate', async (guild: Guild) => {
    await setBotNickname(guild, params.botDisplayName, params.log);
  });

  await client.login(params.token);

  // Wait for cache to be ready before resolving the status channel.
  await new Promise<void>((resolve) => {
    if (client.isReady()) {
      resolve();
    } else {
      client.once('ready', () => resolve());
    }
  });

  // Ensure "System" category scaffold (status/crons/tasks) in a single target guild.
  let system: SystemScaffold | null = null;
  try {
    const guild = selectBootstrapGuild(client, params.guildId, params.log);
    if (guild) {
      system = await ensureSystemScaffold(
        { guild, ensureTasks: Boolean(params.bootstrapEnsureTasksForum), ensureVoiceChannel: Boolean(params.voiceEnabled), botDisplayName: params.botDisplayName, existingCronsId: params.existingCronsId, existingTasksId: params.existingTasksId },
        params.log,
      );
    }
  } catch (err) {
    params.log?.warn({ err }, 'system-bootstrap: failed; continuing without scaffold');
    system = null;
  }

  // Set bot nickname in all guilds.
  for (const guild of client.guilds.cache.values()) {
    await setBotNickname(guild, params.botDisplayName, params.log);
  }

  // Set bot presence (status + activity) on startup.
  if (params.botStatus || params.botActivity) {
    try {
      const presenceData: PresenceData = {};
      if (params.botStatus) {
        presenceData.status = params.botStatus;
      }
      if (params.botActivity) {
        const typeName = params.botActivityType ?? 'Playing';
        const typeNum = ACTIVITY_TYPE_MAP[typeName] ?? ActivityType.Playing;
        if (typeName === 'Custom') {
          presenceData.activities = [{ name: 'Custom Status', type: ActivityType.Custom, state: params.botActivity }];
        } else {
          presenceData.activities = [{ name: params.botActivity, type: typeNum }];
        }
      }
      client.user!.setPresence(presenceData);
      params.log?.info({ status: params.botStatus, activity: params.botActivity, activityType: params.botActivityType }, 'discord:presence set');
    } catch (err) {
      params.log?.warn({ err }, 'discord:presence failed to set');
    }
  }

  // Set bot avatar on startup (rate-limited — applied once).
  if (params.botAvatar) {
    try {
      if (params.botAvatar.startsWith('http://') || params.botAvatar.startsWith('https://')) {
        await client.user!.setAvatar(params.botAvatar);
      } else {
        const buf = await fs.readFile(params.botAvatar);
        await client.user!.setAvatar(buf);
      }
      params.log?.info({ avatar: params.botAvatar }, 'discord:avatar set');
    } catch (err) {
      params.log?.warn({ err, avatar: params.botAvatar }, 'discord:avatar failed to set');
    }
  }

  if (params.statusChannel) {
    statusRef.current = resolveStatusChannel(client, params.statusChannel, { botDisplayName: params.botDisplayName, log: params.log });
    if (!statusRef.current) {
      params.log?.error({ statusChannel: params.statusChannel }, 'status-channel: channel not found, status posting disabled');
    }
  } else if (system?.statusChannelId) {
    statusRef.current = await resolveStatusChannelById(client, system.statusChannelId, { botDisplayName: params.botDisplayName, log: params.log });
    if (!statusRef.current) {
      params.log?.error({ statusChannelId: system.statusChannelId }, 'status-channel: bootstrapped channel not found, status posting disabled');
    }
  }

  return { client, status: statusRef.current, system };
}
