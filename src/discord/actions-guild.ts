import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
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
  | { type: 'searchMessages'; query: string; channel?: string; limit?: number }
  | { type: 'eventList' }
  | { type: 'eventCreate'; name: string; startTime: string; endTime?: string; description?: string; channelId?: string; location?: string };

export const GUILD_ACTION_TYPES = new Set([
  'memberInfo', 'roleInfo', 'roleAdd', 'roleRemove',
  'searchMessages', 'eventList', 'eventCreate',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRole(guild: any, ref: string) {
  // Try by ID.
  const byId = guild.roles.cache.get(ref);
  if (byId) return byId;
  // Try by name (case-insensitive).
  return guild.roles.cache.find(
    (r: any) => r.name.toLowerCase() === ref.toLowerCase(),
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
        `Roles: ${member.roles.cache.filter((r: any) => r.name !== '@everyone').map((r: any) => r.name).join(', ') || '(none)'}`,
      ];
      if (member.user.bot) info.push('Bot: yes');
      return { ok: true, summary: info.join('\n') };
    }

    case 'roleInfo': {
      const roles = [...guild.roles.cache.values()]
        .filter((r: any) => r.name !== '@everyone')
        .sort((a: any, b: any) => b.position - a.position);

      if (roles.length === 0) {
        return { ok: true, summary: 'No custom roles' };
      }

      const lines = roles.map((r: any) => {
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
      const channel = action.channel
        ? resolveChannel(guild, action.channel)
        : guild.channels.cache.get(ctx.channelId);
      if (!channel || !('messages' in channel)) {
        return { ok: false, error: `Channel not found` };
      }

      const limit = Math.min(Math.max(1, action.limit ?? 25), 50);
      const messages = await (channel as any).messages.fetch({ limit: 100 }) as any;
      const query = action.query.toLowerCase();
      const matches = [...messages.values()]
        .filter((m: any) => m.content?.toLowerCase().includes(query))
        .slice(0, limit);

      if (matches.length === 0) {
        return { ok: true, summary: `No messages matching "${action.query}" in #${(channel as any).name}` };
      }

      const lines = matches.map((m: any) => {
        const author = m.author?.username ?? 'Unknown';
        const text = (m.content || '').slice(0, 150);
        return `[${author}] ${text} (id:${m.id})`;
      });
      return { ok: true, summary: `Search results for "${action.query}" in #${(channel as any).name}:\n${lines.join('\n')}` };
    }

    case 'eventList': {
      const events = await guild.scheduledEvents.fetch();
      if (events.size === 0) {
        return { ok: true, summary: 'No scheduled events' };
      }

      const lines = [...events.values()].map((e: any) => {
        const start = e.scheduledStartAt ? fmtTime(e.scheduledStartAt) : 'TBD';
        return `${e.name} — ${start}${e.description ? ` — ${e.description.slice(0, 80)}` : ''}`;
      });
      return { ok: true, summary: `Scheduled events:\n${lines.join('\n')}` };
    }

    case 'eventCreate': {
      const startTime = new Date(action.startTime);
      if (isNaN(startTime.getTime())) {
        return { ok: false, error: `Invalid startTime: "${action.startTime}"` };
      }

      const opts: any = {
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

      const event = await guild.scheduledEvents.create(opts);
      return { ok: true, summary: `Created event "${event.name}"` };
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

**searchMessages** — Search recent messages in a channel (client-side filter, limited):
\`\`\`
<discord-action>{"type":"searchMessages","query":"keyword","channel":"#general","limit":10}</discord-action>
\`\`\`
- \`query\` (required): Text to search for (case-insensitive substring match).
- \`channel\` (optional): Channel to search; defaults to current channel.
- \`limit\` (optional): Max results (1–50, default 25). Searches last 100 messages only.

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
- \`location\` (optional): External location (creates an external event).`;
}
