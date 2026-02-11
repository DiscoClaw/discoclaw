import { EmbedBuilder } from 'discord.js';
import type { LoggerLike } from './action-types.js';

type Sendable = { send(opts: { embeds: EmbedBuilder[] }): Promise<unknown> };

export type StatusPoster = {
  online(): Promise<void>;
  offline(): Promise<void>;
  runtimeError(context: { sessionKey: string; channelName?: string }, message: string): Promise<void>;
  handlerError(context: { sessionKey: string }, err: unknown): Promise<void>;
  actionFailed(actionType: string, error: string): Promise<void>;
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
        .setDescription((message || '(no message)').slice(0, 4096))
        .setTimestamp();
      if (context.sessionKey) embed.addFields({ name: 'Session', value: context.sessionKey, inline: true });
      if (context.channelName) embed.addFields({ name: 'Channel', value: context.channelName, inline: true });
      await send(embed);
    },

    async handlerError(context, err) {
      const embed = new EmbedBuilder()
        .setColor(Colors.red)
        .setTitle('Handler Failure')
        .setDescription((String(err) || '(unknown error)').slice(0, 4096))
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
  };
}
