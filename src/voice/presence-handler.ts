/**
 * Voice presence detection — automatically joins/leaves voice channels
 * based on non-bot user presence.
 *
 * - Auto-joins when the first non-bot user enters a voice channel (if bot
 *   is not already connected to the guild).
 * - Auto-leaves when the last non-bot user leaves the channel the bot is in.
 */

import type { VoiceState, Collection, GuildMember } from 'discord.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { VoiceConnectionManager } from './connection-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoicePresenceHandlerOpts = {
  log: LoggerLike;
  voiceManager: VoiceConnectionManager;
  /** The bot's own user ID — used for self-identification in logs. */
  botUserId: string;
};

// ---------------------------------------------------------------------------
// VoicePresenceHandler
// ---------------------------------------------------------------------------

export class VoicePresenceHandler {
  private readonly log: LoggerLike;
  private readonly voiceManager: VoiceConnectionManager;
  private readonly botUserId: string;

  constructor(opts: VoicePresenceHandlerOpts) {
    this.log = opts.log;
    this.voiceManager = opts.voiceManager;
    this.botUserId = opts.botUserId;
  }

  /**
   * Handle a Discord `voiceStateUpdate` event. Call this from the client's
   * event listener:
   *
   * ```ts
   * client.on('voiceStateUpdate', (old, cur) => handler.handleVoiceStateUpdate(old, cur));
   * ```
   */
  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const member = newState.member ?? oldState.member;
    if (!member) return;

    // Ignore bot users (including ourselves).
    if (member.user.bot) return;

    const guildId = newState.guild.id;
    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    // User joined a channel (or moved to a new one).
    if (newChannelId && newChannelId !== oldChannelId) {
      this.handleUserJoined(guildId, newState);
    }

    // User left a channel (or moved away from old one).
    if (oldChannelId && oldChannelId !== newChannelId) {
      this.handleUserLeft(guildId, oldState);
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleUserJoined(guildId: string, state: VoiceState): void {
    // Already connected to this guild — don't rejoin.
    if (this.voiceManager.getConnection(guildId)) return;

    const channel = state.channel;
    if (!channel) return;

    this.log.info(
      { guildId, channelId: channel.id, userId: state.member?.id },
      'voice:presence: user joined, auto-joining channel',
    );

    this.voiceManager.join({
      channelId: channel.id,
      guildId,
      adapterCreator: state.guild.voiceAdapterCreator,
    });
  }

  private handleUserLeft(guildId: string, state: VoiceState): void {
    const connection = this.voiceManager.getConnection(guildId);
    if (!connection) return;

    // Only auto-leave if the bot is in the same channel the user left.
    const botChannelId = connection.joinConfig.channelId;
    if (botChannelId !== state.channelId) return;

    const channel = state.channel;
    if (!channel) return;

    // By the time this event fires, channel.members already reflects the
    // updated state (the leaving user is removed).
    const nonBotCount = countNonBotMembers(channel.members);

    if (nonBotCount === 0) {
      this.log.info(
        { guildId, channelId: channel.id },
        'voice:presence: last non-bot user left, auto-leaving channel',
      );
      this.voiceManager.leave(guildId);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countNonBotMembers(members: Collection<string, GuildMember>): number {
  let count = 0;
  for (const [, m] of members) {
    if (!m.user.bot) count++;
  }
  return count;
}
