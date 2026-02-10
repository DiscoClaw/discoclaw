import { ChannelType } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelActionRequest =
  | { type: 'channelCreate'; name: string; parent?: string; topic?: string }
  | { type: 'channelEdit'; channelId: string; name?: string; topic?: string }
  | { type: 'channelDelete'; channelId: string }
  | { type: 'channelList' }
  | { type: 'channelInfo'; channelId: string }
  | { type: 'categoryCreate'; name: string; position?: number };

export const CHANNEL_ACTION_TYPES = new Set([
  'channelCreate', 'channelEdit', 'channelDelete',
  'channelList', 'channelInfo', 'categoryCreate',
]);

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeChannelAction(
  action: ChannelActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;

  switch (action.type) {
    case 'channelCreate': {
      let parent: string | undefined;
      if (action.parent) {
        const cat = guild.channels.cache.find(
          (ch) =>
            ch.type === ChannelType.GuildCategory &&
            ch.name.toLowerCase() === action.parent!.toLowerCase(),
        );
        if (cat) {
          parent = cat.id;
        } else {
          return { ok: false, error: `Category "${action.parent}" not found` };
        }
      }

      const created = await guild.channels.create({
        name: action.name,
        type: ChannelType.GuildText,
        parent,
        topic: action.topic,
      });
      return { ok: true, summary: `Created #${created.name}${parent ? ` under ${action.parent}` : ''}` };
    }

    case 'channelEdit': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      const edits: any = {};
      if (action.name != null) edits.name = action.name;
      if (action.topic != null) edits.topic = action.topic;

      await (channel as any).edit(edits);
      const parts: string[] = [];
      if (action.name != null) parts.push(`name → ${action.name}`);
      if (action.topic != null) parts.push(`topic updated`);
      return { ok: true, summary: `Edited #${channel.name}: ${parts.join(', ')}` };
    }

    case 'channelDelete': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const name = channel.name;
      await (channel as any).delete();
      return { ok: true, summary: `Deleted #${name}` };
    }

    case 'channelList': {
      const grouped = new Map<string, string[]>();
      const uncategorized: string[] = [];

      for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildCategory) continue;
        const parentName = ch.parent?.name;
        if (parentName) {
          const list = grouped.get(parentName) ?? [];
          list.push(`#${ch.name}`);
          grouped.set(parentName, list);
        } else {
          uncategorized.push(`#${ch.name}`);
        }
      }

      const lines: string[] = [];
      if (uncategorized.length > 0) {
        lines.push(`(no category): ${uncategorized.join(', ')}`);
      }
      for (const [cat, chs] of grouped) {
        lines.push(`${cat}: ${chs.join(', ')}`);
      }
      return { ok: true, summary: lines.length > 0 ? lines.join('\n') : '(no channels)' };
    }

    case 'channelInfo': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      const info: string[] = [
        `Name: #${channel.name}`,
        `ID: ${channel.id}`,
        `Type: ${ChannelType[channel.type] ?? channel.type}`,
      ];
      if (channel.parent) info.push(`Category: ${channel.parent.name}`);
      if ('topic' in channel && (channel as any).topic) info.push(`Topic: ${(channel as any).topic}`);
      if ('createdAt' in channel && (channel as any).createdAt) {
        info.push(`Created: ${(channel as any).createdAt.toISOString().slice(0, 10)}`);
      }
      return { ok: true, summary: info.join('\n') };
    }

    case 'categoryCreate': {
      const created = await guild.channels.create({
        name: action.name,
        type: ChannelType.GuildCategory,
        position: action.position,
      } as any);
      return { ok: true, summary: `Created category "${created.name}"` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function channelActionsPromptSection(): string {
  return `### Channel Management

**channelCreate** — Create a text channel:
\`\`\`
<discord-action>{"type":"channelCreate","name":"channel-name","parent":"Category Name","topic":"Optional topic"}</discord-action>
\`\`\`
- \`name\` (required): Channel name (lowercase, hyphens, no spaces).
- \`parent\` (optional): Category name to create the channel under.
- \`topic\` (optional): Channel topic description.

**channelEdit** — Edit a channel's name or topic:
\`\`\`
<discord-action>{"type":"channelEdit","channelId":"123","name":"new-name","topic":"New topic"}</discord-action>
\`\`\`
- \`channelId\` (required): Channel ID.
- \`name\` (optional): New channel name.
- \`topic\` (optional): New channel topic.

**channelDelete** — Delete a channel (destructive — confirm with user first):
\`\`\`
<discord-action>{"type":"channelDelete","channelId":"123"}</discord-action>
\`\`\`

**channelList** — List all channels in the server:
\`\`\`
<discord-action>{"type":"channelList"}</discord-action>
\`\`\`

**channelInfo** — Get details about a channel:
\`\`\`
<discord-action>{"type":"channelInfo","channelId":"123"}</discord-action>
\`\`\`

**categoryCreate** — Create a channel category:
\`\`\`
<discord-action>{"type":"categoryCreate","name":"Category Name"}</discord-action>
\`\`\``;
}
