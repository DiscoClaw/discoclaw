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
  if (byId && isTextBased(byId)) return byId as GuildTextBasedChannel;

  // Try by name (case-insensitive).
  const byName = guild.channels.cache.find(
    (ch) => isTextBased(ch) && ch.name.toLowerCase() === cleaned.toLowerCase(),
  );
  return byName as GuildTextBasedChannel | undefined;
}

function isTextBased(ch: any): boolean {
  return (
    ch.type === ChannelType.GuildText ||
    ch.type === ChannelType.GuildAnnouncement ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread ||
    ch.type === ChannelType.GuildForum ||
    ch.type === ChannelType.GuildVoice
  );
}

/** Format a timestamp for display. */
export function fmtTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
