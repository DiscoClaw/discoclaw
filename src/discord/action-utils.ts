import { ChannelType } from 'discord.js';
import type { Guild, GuildTextBasedChannel } from 'discord.js';

/**
 * Resolve a channel reference to a text-based guild channel.
 * Accepts:
 *   - A numeric channel ID string (e.g. "123456789")
 *   - A channel name with or without # prefix (e.g. "#general" or "general")
 */
export function resolveChannel(
  guild: Guild,
  ref: string,
): GuildTextBasedChannel | undefined {
  const cleaned = ref.replace(/^#/, '').trim();
  if (!cleaned) return undefined;

  // Try by ID first (numeric strings).
  const byId = guild.channels.cache.get(cleaned);
  if (byId) {
    // If the ID matched but isn't text-based, don't fall through to name lookup —
    // the caller explicitly referenced this channel by ID.
    return isTextBased(byId) ? (byId as GuildTextBasedChannel) : undefined;
  }

  // Try by name (case-insensitive).
  const byName = guild.channels.cache.find(
    (ch) => isTextBased(ch) && ch.name.toLowerCase() === cleaned.toLowerCase(),
  );
  return byName as GuildTextBasedChannel | undefined;
}

function isTextBased(ch: any): boolean {
  // We only want channels that are meaningfully sendable via `.send()`.
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  );
}

/** Human-readable channel type name for error messages. */
export function describeChannelType(ch: any): string {
  switch (ch?.type) {
    case ChannelType.GuildForum: return 'forum';
    case ChannelType.GuildMedia: return 'media';
    case ChannelType.GuildVoice: return 'voice';
    case ChannelType.GuildStageVoice: return 'stage';
    case ChannelType.GuildCategory: return 'category';
    default: return 'unsupported';
  }
}

/**
 * Look up a channel by ref (ID or name) and return it raw, without filtering
 * by type. Returns undefined only if the channel truly doesn't exist.
 */
export function findChannelRaw(guild: Guild, ref: string): any | undefined {
  const cleaned = ref.replace(/^#/, '').trim();
  if (!cleaned) return undefined;

  const byId = guild.channels.cache.get(cleaned);
  if (byId) return byId;

  return guild.channels.cache.find(
    (ch) => ch.name.toLowerCase() === cleaned.toLowerCase(),
  );
}

/** Format a timestamp for display. */
export function fmtTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
