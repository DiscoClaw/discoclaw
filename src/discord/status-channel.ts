import { EmbedBuilder } from 'discord.js';
import type { LoggerLike } from './action-types.js';
import type { BeadSyncResult } from '../beads/types.js';

type Sendable = { send(opts: { embeds: EmbedBuilder[] }): Promise<unknown> };

/**
 * Strip CLI args and prompt content from error messages so internals
 * (SOUL.md, IDENTITY.md, full prompts) don't leak into status channel embeds.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return '(no message)';

  // execa kill messages look like:
  //   "Command was killed with SIGKILL (Forced termination): claude -p \"You are...\""
  // Strip everything after the signal description by splitting on ": claude "
  const claudeCliIdx = raw.indexOf(': claude ');
  if (claudeCliIdx !== -1) {
    return raw.slice(0, claudeCliIdx).slice(0, 500);
  }

  // Generic: if the message contains "claude -p" anywhere, truncate before it
  const dashPIdx = raw.indexOf('claude -p');
  if (dashPIdx !== -1) {
    const prefix = raw.slice(0, dashPIdx).trimEnd();
    return (prefix || 'Command failed').slice(0, 500);
  }

  // Safety-net truncation for any other long message
  return raw.slice(0, 500);
}

export type StatusPoster = {
  online(): Promise<void>;
  offline(): Promise<void>;
  runtimeError(context: { sessionKey: string; channelName?: string }, message: string): Promise<void>;
  handlerError(context: { sessionKey: string }, err: unknown): Promise<void>;
  actionFailed(actionType: string, error: string): Promise<void>;
  beadSyncComplete(result: BeadSyncResult): Promise<void>;
};

const Colors = {
  green: 0x57f287,
  gray: 0x95a5a6,
  red: 0xed4245,
  orange: 0xfee75c,
} as const;

export type StatusPosterOpts = {
  botDisplayName?: string;
  log?: LoggerLike;
};

export function createStatusPoster(channel: Sendable, opts?: StatusPosterOpts): StatusPoster {
  const name = opts?.botDisplayName ?? 'Discoclaw';
  const log = opts?.log;
  const send = async (embed: EmbedBuilder) => {
    try {
      await channel.send({ embeds: [embed] });
    } catch (err) {
      log?.warn({ err }, 'status-channel: failed to post status embed');
    }
  };

  return {
    async online() {
      await send(
        new EmbedBuilder()
          .setColor(Colors.green)
          .setTitle('Bot Online')
          .setDescription(`${name} is connected and ready.`)
          .setTimestamp(),
      );
    },

    async offline() {
      await send(
        new EmbedBuilder()
          .setColor(Colors.gray)
          .setTitle('Bot Offline')
          .setDescription(`${name} is shutting down.`)
          .setTimestamp(),
      );
    },

    async runtimeError(context, message) {
      const embed = new EmbedBuilder()
        .setColor(Colors.red)
        .setTitle('Runtime Error')
        .setDescription(sanitizeErrorMessage(message).slice(0, 4096))
        .setTimestamp();
      if (context.sessionKey) embed.addFields({ name: 'Session', value: context.sessionKey, inline: true });
      if (context.channelName) embed.addFields({ name: 'Channel', value: context.channelName, inline: true });
      await send(embed);
    },

    async handlerError(context, err) {
      const embed = new EmbedBuilder()
        .setColor(Colors.red)
        .setTitle('Handler Failure')
        .setDescription(sanitizeErrorMessage(String(err) || '(unknown error)').slice(0, 4096))
        .setTimestamp();
      if (context.sessionKey) embed.addFields({ name: 'Session', value: context.sessionKey, inline: true });
      await send(embed);
    },

    async actionFailed(actionType, error) {
      await send(
        new EmbedBuilder()
          .setColor(Colors.orange)
          .setTitle('Action Failed')
          .addFields(
            { name: 'Action', value: actionType || '(unknown)', inline: true },
            { name: 'Error', value: (error || '(unknown)').slice(0, 1024) },
          )
          .setTimestamp(),
      );
    },

    async beadSyncComplete(result) {
      const { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, warnings } = result;
      const allZero = threadsCreated === 0 && emojisUpdated === 0 && starterMessagesUpdated === 0 && threadsArchived === 0 && statusesUpdated === 0 && tagsUpdated === 0;
      if (allZero && warnings === 0) return;

      const color = warnings > 0 ? Colors.orange : Colors.green;
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Bead Sync Complete')
        .setTimestamp();

      if (threadsCreated > 0) embed.addFields({ name: 'Created', value: String(threadsCreated), inline: true });
      if (emojisUpdated > 0) embed.addFields({ name: 'Names Updated', value: String(emojisUpdated), inline: true });
      if (starterMessagesUpdated > 0) embed.addFields({ name: 'Starters Updated', value: String(starterMessagesUpdated), inline: true });
      if (threadsArchived > 0) embed.addFields({ name: 'Archived', value: String(threadsArchived), inline: true });
      if (statusesUpdated > 0) embed.addFields({ name: 'Statuses Fixed', value: String(statusesUpdated), inline: true });
      if (tagsUpdated > 0) embed.addFields({ name: 'Tags Updated', value: String(tagsUpdated), inline: true });
      if (warnings > 0) embed.addFields({ name: 'Warnings', value: String(warnings), inline: true });

      await send(embed);
    },
  };
}
