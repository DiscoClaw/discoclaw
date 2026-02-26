/**
 * Transcript mirror — posts voice conversation transcriptions (user STT and
 * AI TTS responses) to a designated Discord text channel, creating a
 * persistent text record of voice conversations.
 */

import type { Client, MessageMentionOptions } from 'discord.js';
import { NO_MENTIONS } from '../discord/allowed-mentions.js';
import type { LoggerLike } from '../logging/logger-like.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Sendable = { send(content: string | { content: string; allowedMentions?: MessageMentionOptions }): Promise<unknown> };

/** Interface for transcript mirror consumers — allows simple test doubles. */
export interface TranscriptMirrorLike {
  postUserTranscription(username: string, text: string): Promise<void>;
  postBotResponse(botName: string, text: string): Promise<void>;
}

export type TranscriptMirrorOpts = {
  client: Client;
  nameOrId: string;
  log: LoggerLike;
};

// ---------------------------------------------------------------------------
// TranscriptMirror
// ---------------------------------------------------------------------------

export class TranscriptMirror implements TranscriptMirrorLike {
  private readonly client: Client;
  private readonly nameOrId: string;
  private readonly log: LoggerLike;
  private resolvedChannel: Sendable | null = null;
  private resolveFailed = false;

  constructor(opts: TranscriptMirrorOpts) {
    this.client = opts.client;
    this.nameOrId = opts.nameOrId;
    this.log = opts.log;
  }

  /**
   * Factory — returns a TranscriptMirror if nameOrId is provided, undefined otherwise.
   * Channel resolution is deferred to first use (lazy).
   */
  static async resolve(
    client: Client,
    nameOrId: string | undefined,
    log: LoggerLike,
  ): Promise<TranscriptMirror | undefined> {
    if (!nameOrId) return undefined;
    log.info({ channelId: nameOrId }, 'transcript-mirror: initialized');
    return new TranscriptMirror({ client, nameOrId, log });
  }

  /**
   * Post a user's speech transcription to the transcript channel.
   */
  async postUserTranscription(username: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const content = `**${sanitizeUsername(username)}** (voice): ${text}`;
    await this.send(content);
  }

  /**
   * Post the AI's voice response text to the transcript channel.
   */
  async postBotResponse(botName: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const content = `**${sanitizeUsername(botName)}** (voice reply): ${text}`;
    await this.send(content);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async send(content: string): Promise<void> {
    const channel = await this.resolveChannel();
    if (!channel) return;

    try {
      await channel.send({ content: truncate(content, 2000), allowedMentions: NO_MENTIONS });
    } catch (err) {
      this.log.warn({ err, channelId: this.nameOrId }, 'transcript-mirror: failed to send message');
    }
  }

  private async resolveChannel(): Promise<Sendable | null> {
    if (this.resolvedChannel) return this.resolvedChannel;
    if (this.resolveFailed) return null;

    try {
      // Try by ID: cache first, then API fetch
      const cached = this.client.channels.cache.get(this.nameOrId);
      const byId = cached ?? (await this.client.channels.fetch(this.nameOrId).catch(() => null));
      if (byId?.isTextBased() && !byId.isDMBased() && 'send' in byId) {
        this.resolvedChannel = byId as Sendable;
        this.log.info({ channelId: this.nameOrId }, 'transcript-mirror: channel resolved');
        return this.resolvedChannel;
      }

      // Fall back to scanning guild caches by name
      for (const guild of this.client.guilds.cache.values()) {
        const ch = guild.channels.cache.find(
          (c) => c.isTextBased() && c.name === this.nameOrId,
        );
        if (ch && ch.isTextBased() && 'send' in ch) {
          this.resolvedChannel = ch as Sendable;
          this.log.info({ channelId: this.nameOrId }, 'transcript-mirror: channel resolved by name');
          return this.resolvedChannel;
        }
      }

      this.log.warn({ channelId: this.nameOrId }, 'transcript-mirror: channel not found or not text-based');
      this.resolveFailed = true;
      return null;
    } catch (err) {
      this.log.warn({ err, channelId: this.nameOrId }, 'transcript-mirror: failed to resolve channel');
      this.resolveFailed = true;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip markdown bold markers from usernames to prevent formatting exploits. */
function sanitizeUsername(name: string): string {
  return name.replace(/\*/g, '');
}

/** Truncate to Discord message limit. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}
