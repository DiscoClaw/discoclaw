import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
import type { Guild, Role } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import { resolveChannel, fmtTime } from './action-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuildActionRequest =
  | { type: 'memberInfo'; userId: string }
  | { type: 'roleInfo' }
  | { type: 'roleAdd'; userId: string; role: string }
  | { type: 'roleRemove'; userId: string; role: string }
  | { type: 'searchMessages'; query: string; channel?: string; limit?: number;
      before?: string; after?: string; maxPages?: number }
  | { type: 'eventList' }
  | { type: 'eventCreate'; name: string; startTime: string; endTime?: string; description?: string; channelId?: string; location?: string }
  | { type: 'eventEdit'; eventId: string; name?: string; startTime?: string; endTime?: string; description?: string; location?: string }
  | { type: 'eventDelete'; eventId: string };

const GUILD_TYPE_MAP: Record<GuildActionRequest['type'], true> = {
  memberInfo: true, roleInfo: true, roleAdd: true, roleRemove: true,
  searchMessages: true, eventList: true, eventCreate: true, eventEdit: true, eventDelete: true,
};
export const GUILD_ACTION_TYPES = new Set<string>(Object.keys(GUILD_TYPE_MAP));

type SearchMessage = {
  id: string;
  content: string;
  author?: { username?: string };
  createdAt?: Date | null;
};

type SearchableChannel = {
  name: string;
  messages: {
    fetch(opts: { limit: number; before?: string }): Promise<{ values(): Iterable<SearchMessage> }>;
  };
};

function asSearchableChannel(channel: unknown): SearchableChannel | null {
  if (!channel || typeof channel !== 'object') return null;
  if (!('messages' in channel) || !('name' in channel)) return null;
  const messages = (channel as { messages?: unknown }).messages;
  const name = (channel as { name?: unknown }).name;
  if (!messages || typeof messages !== 'object' || typeof name !== 'string') return null;
  if (!('fetch' in messages) || typeof (messages as { fetch?: unknown }).fetch !== 'function') return null;
  return channel as SearchableChannel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Discord epoch: 2015-01-01T00:00:00.000Z
const DISCORD_EPOCH = 1420070400000n;

/**
 * Convert an ISO date string or raw snowflake ID to a Discord snowflake string.
 * Returns null on invalid input.
 */
export function isoToSnowflake(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already a snowflake (numeric string, 17-20 digits)?
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;

  // Try ISO date parse.
  const ms = Date.parse(trimmed);
  if (isNaN(ms)) return null;
  if (BigInt(ms) < DISCORD_EPOCH) return null;

  const snowflake = (BigInt(ms) - DISCORD_EPOCH) << 22n;
  return snowflake.toString();
}

function resolveRole(guild: Guild, ref: string): Role | undefined {
  // Try by ID.
  const byId = guild.roles.cache.get(ref);
  if (byId) return byId;
  // Try by name (case-insensitive).
  return guild.roles.cache.find(
    (r) => r.name.toLowerCase() === ref.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeGuildAction(
  action: GuildActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;

  switch (action.type) {
    case 'memberInfo': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };

      const info: string[] = [
        `Username: ${member.user.username}`,
        `Display: ${member.displayName}`,
        `ID: ${member.id}`,
        `Joined: ${member.joinedAt ? fmtTime(member.joinedAt) : 'unknown'}`,
        `Roles: ${member.roles.cache.filter((r) => r.name !== '@everyone').map((r) => r.name).join(', ') || '(none)'}`,
      ];
      if (member.user.bot) info.push('Bot: yes');
      return { ok: true, summary: info.join('\n') };
    }

    case 'roleInfo': {
      const roles = [...guild.roles.cache.values()]
        .filter((r) => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position);

      if (roles.length === 0) {
        return { ok: true, summary: 'No custom roles' };
      }

      const lines = roles.map((r) => {
        const members = r.members?.size ?? '?';
        return `${r.name} (id:${r.id}, ${members} members)`;
      });
      return { ok: true, summary: `Roles:\n${lines.join('\n')}` };
    }

    case 'roleAdd': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      const role = resolveRole(guild, action.role);
      if (!role) return { ok: false, error: `Role "${action.role}" not found` };
      await member.roles.add(role.id);
      return { ok: true, summary: `Added role "${role.name}" to ${member.displayName}` };
    }

    case 'roleRemove': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      const role = resolveRole(guild, action.role);
      if (!role) return { ok: false, error: `Role "${action.role}" not found` };
      await member.roles.remove(role.id);
      return { ok: true, summary: `Removed role "${role.name}" from ${member.displayName}` };
    }

    case 'searchMessages': {
      const rawChannel = action.channel
        ? resolveChannel(guild, action.channel)
        : guild.channels.cache.get(ctx.channelId);
      const channel = asSearchableChannel(rawChannel);
      if (!channel) {
        return { ok: false, error: `Channel not found` };
      }

      const limit = Math.min(Math.max(1, action.limit ?? 25), 50);
      const maxPages = Math.min(Math.max(1, action.maxPages ?? 5), 10);
      const beforeSnowflake = action.before ? isoToSnowflake(action.before) : null;
      const afterSnowflake = action.after ? isoToSnowflake(action.after) : null;

      const query = action.query.toLowerCase();
      const matches: SearchMessage[] = [];
      let cursor: string | undefined = beforeSnowflake ?? undefined;
      let totalScanned = 0;
      let hitAfterBound = false;

      for (let page = 0; page < maxPages; page++) {
        const fetchOpts: { limit: number; before?: string } = { limit: 100 };
        if (cursor) fetchOpts.before = cursor;

        const batch = await channel.messages.fetch(fetchOpts);
        const msgs = [...batch.values()];
        if (msgs.length === 0) break;

        for (const m of msgs) {
          // If we've passed the after boundary, stop entirely.
          if (afterSnowflake && BigInt(m.id) <= BigInt(afterSnowflake)) {
            hitAfterBound = true;
            break;
          }

          totalScanned++;
          if (m.content?.toLowerCase().includes(query) && matches.length < limit) {
            matches.push(m);
          }
        }

        // Update cursor to oldest message in this batch.
        cursor = msgs[msgs.length - 1].id;

        if (hitAfterBound) break;
        if (matches.length >= limit) break;
        if (msgs.length < 100) break; // End of channel.
      }

      if (matches.length === 0) {
        return { ok: true, summary: `No messages matching "${action.query}" in #${channel.name} (scanned ${totalScanned} messages)` };
      }

      const lines = matches.map((m) => {
        const author = m.author?.username ?? 'Unknown';
        const ts = m.createdAt ? fmtTime(m.createdAt) : '';
        const text = (m.content || '').slice(0, 150);
        return `[${ts}] [${author}] ${text} (id:${m.id})`;
      });
      return { ok: true, summary: `Search results for "${action.query}" in #${channel.name} (${matches.length} found, ${totalScanned} scanned):\n${lines.join('\n')}` };
    }

    case 'eventList': {
      const events = await guild.scheduledEvents.fetch();
      if (events.size === 0) {
        return { ok: true, summary: 'No scheduled events' };
      }

      const lines = [...events.values()].map((e) => {
        const start = e.scheduledStartAt ? fmtTime(e.scheduledStartAt) : 'TBD';
        return `${e.name} (id:${e.id}) — ${start}${e.description ? ` — ${e.description.slice(0, 80)}` : ''}`;
      });
      return { ok: true, summary: `Scheduled events:\n${lines.join('\n')}` };
    }

    case 'eventCreate': {
      const startTime = new Date(action.startTime);
      if (isNaN(startTime.getTime())) {
        return { ok: false, error: `Invalid startTime: "${action.startTime}"` };
      }

      const opts: Record<string, unknown> = {
        name: action.name,
        scheduledStartTime: startTime.toISOString(),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        description: action.description,
      };

      if (action.endTime) {
        const endTime = new Date(action.endTime);
        if (!isNaN(endTime.getTime())) {
          opts.scheduledEndTime = endTime.toISOString();
        }
      }

      if (action.location) {
        opts.entityType = GuildScheduledEventEntityType.External;
        opts.entityMetadata = { location: action.location };
        if (!opts.scheduledEndTime) {
          // External events require an end time. Default to +1 hour.
          opts.scheduledEndTime = new Date(startTime.getTime() + 3600_000).toISOString();
        }
      } else if (action.channelId) {
        opts.entityType = GuildScheduledEventEntityType.Voice;
        opts.channel = action.channelId;
      } else {
        opts.entityType = GuildScheduledEventEntityType.External;
        opts.entityMetadata = { location: 'TBD' };
        if (!opts.scheduledEndTime) {
          opts.scheduledEndTime = new Date(startTime.getTime() + 3600_000).toISOString();
        }
      }

      const event = await guild.scheduledEvents.create(opts as unknown as Parameters<Guild['scheduledEvents']['create']>[0]);
      return { ok: true, summary: `Created event "${event.name}"` };
    }

    case 'eventEdit': {
      const { eventId, name, startTime, endTime, description, location } = action;
      if (!name && !startTime && !endTime && description === undefined && !location) {
        return { ok: false, error: 'eventEdit requires at least one field to update' };
      }

      const edits: Record<string, unknown> = {};
      if (name) edits.name = name;
      if (description !== undefined) edits.description = description;
      if (location) edits.entityMetadata = { location };

      if (startTime) {
        const d = new Date(startTime);
        if (isNaN(d.getTime())) return { ok: false, error: `Invalid startTime: "${startTime}"` };
        edits.scheduledStartTime = d.toISOString();
      }
      if (endTime) {
        const d = new Date(endTime);
        if (isNaN(d.getTime())) return { ok: false, error: `Invalid endTime: "${endTime}"` };
        edits.scheduledEndTime = d.toISOString();
      }

      const event = await guild.scheduledEvents.edit(eventId, edits as unknown as Parameters<Guild['scheduledEvents']['edit']>[1]);
      return { ok: true, summary: `Edited event "${event.name}"` };
    }

    case 'eventDelete': {
      const event = await guild.scheduledEvents.fetch(action.eventId).catch(() => null);
      const name = event?.name ?? action.eventId;
      await guild.scheduledEvents.delete(action.eventId);
      return { ok: true, summary: `Deleted event "${name}"` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function guildActionsPromptSection(): string {
  return `### Guild Info & Management

**memberInfo** — Get info about a server member:
\`\`\`
<discord-action>{"type":"memberInfo","userId":"123456789"}</discord-action>
\`\`\`

**roleInfo** — List all roles in the server:
\`\`\`
<discord-action>{"type":"roleInfo"}</discord-action>
\`\`\`

**roleAdd** / **roleRemove** — Add or remove a role from a member:
\`\`\`
<discord-action>{"type":"roleAdd","userId":"123","role":"Moderator"}</discord-action>
<discord-action>{"type":"roleRemove","userId":"123","role":"Moderator"}</discord-action>
\`\`\`
- \`role\`: Role name or ID.

**searchMessages** — Search messages in a channel (paginated, client-side filter):
\`\`\`
<discord-action>{"type":"searchMessages","query":"keyword","channel":"#general","limit":10}</discord-action>
\`\`\`
- \`query\` (required): Text to search for (case-insensitive substring match).
- \`channel\` (optional): Channel to search; defaults to current channel.
- \`limit\` (optional): Max results (1–50, default 25).
- \`before\` (optional): Message ID or ISO date — only search messages before this point.
- \`after\` (optional): Message ID or ISO date — stop scanning at this point.
- \`maxPages\` (optional): Pages of 100 messages to scan (1–10, default 5 = 500 messages).

**eventList** — List scheduled events:
\`\`\`
<discord-action>{"type":"eventList"}</discord-action>
\`\`\`

**eventCreate** — Create a scheduled event:
\`\`\`
<discord-action>{"type":"eventCreate","name":"Team Meeting","startTime":"2025-02-01T15:00:00Z","description":"Weekly sync","location":"Zoom"}</discord-action>
\`\`\`
- \`name\` (required): Event name.
- \`startTime\` (required): ISO 8601 datetime.
- \`endTime\` (optional): ISO 8601 datetime.
- \`description\` (optional): Event description.
- \`channelId\` (optional): Voice channel ID for voice events.
- \`location\` (optional): External location (creates an external event).

**eventEdit** — Edit a scheduled event:
\`\`\`
<discord-action>{"type":"eventEdit","eventId":"123","name":"New Name","startTime":"2025-03-01T10:00:00Z"}</discord-action>
\`\`\`
- \`eventId\` (required): Event ID (from eventList).
- \`name\` (optional): New event name.
- \`startTime\` (optional): New ISO 8601 start time.
- \`endTime\` (optional): New ISO 8601 end time.
- \`description\` (optional): New description.
- \`location\` (optional): New external location.
At least one field besides eventId is required.

**eventDelete** — Delete a scheduled event (destructive — confirm with user first):
\`\`\`
<discord-action>{"type":"eventDelete","eventId":"123"}</discord-action>
\`\`\``;
}
