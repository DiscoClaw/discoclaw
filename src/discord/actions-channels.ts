import { ChannelType } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelActionRequest =
  | { type: 'channelCreate'; name: string; parent?: string; topic?: string }
  | { type: 'channelList' };

export const CHANNEL_ACTION_TYPES = new Set(['channelCreate', 'channelList']);

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

**channelList** — List all channels in the server:
\`\`\`
<discord-action>{"type":"channelList"}</discord-action>
\`\`\``;
}
