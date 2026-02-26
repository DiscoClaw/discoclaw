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

export type TranscriptMirrorOpts = {
  client: Client;
  channelId: string;
  log: LoggerLike;
};

// ---------------------------------------------------------------------------
// TranscriptMirror
// ---------------------------------------------------------------------------

export class TranscriptMirror {
  private readonly client: Client;
  private readonly channelId: string;
  private readonly log: LoggerLike;
  private resolvedChannel: Sendable | null = null;
  private resolveFailed = false;

  constructor(opts: TranscriptMirrorOpts) {
    this.client = opts.client;
    this.channelId = opts.channelId;
    this.log = opts.log;
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
      this.log.warn({ err, channelId: this.channelId }, 'transcript-mirror: failed to send message');
    }
  }

  private async resolveChannel(): Promise<Sendable | null> {
    if (this.resolvedChannel) return this.resolvedChannel;
    if (this.resolveFailed) return null;

    try {
      const cached = this.client.channels.cache.get(this.channelId);
      const ch = cached ?? (await this.client.channels.fetch(this.channelId).catch(() => null));
      if (ch?.isTextBased() && !ch.isDMBased() && 'send' in ch) {
        this.resolvedChannel = ch as Sendable;
        this.log.info({ channelId: this.channelId }, 'transcript-mirror: channel resolved');
        return this.resolvedChannel;
      }
      this.log.warn({ channelId: this.channelId }, 'transcript-mirror: channel not found or not text-based');
      this.resolveFailed = true;
      return null;
    } catch (err) {
      this.log.warn({ err, channelId: this.channelId }, 'transcript-mirror: failed to resolve channel');
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
