import { ChannelType } from 'discord.js';
import type { ForumChannel, GuildChannel, ThreadChannel } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelActionRequest =
  | { type: 'channelCreate'; name: string; parent?: string; topic?: string; channelType?: 'text' | 'voice' | 'announcement' | 'stage' }
  | { type: 'channelEdit'; channelId: string; name?: string; topic?: string }
  | { type: 'channelDelete'; channelId: string }
  | { type: 'channelList' }
  | { type: 'channelInfo'; channelId: string }
  | { type: 'categoryCreate'; name: string; position?: number }
  | { type: 'channelMove'; channelId: string; parent?: string; position?: number }
  | { type: 'threadListArchived'; channelId: string; limit?: number }
  | { type: 'forumTagCreate'; channelId: string; name: string; emoji?: { id?: string; name?: string } }
  | { type: 'forumTagDelete'; channelId: string; tagId: string }
  | { type: 'forumTagList'; channelId: string }
  | { type: 'threadEdit'; threadId: string; appliedTags?: string[]; name?: string };

// Record ensures every union member is listed; TS errors if a new type is added to the union but not here.
const CHANNEL_TYPE_MAP: Record<ChannelActionRequest['type'], true> = {
  channelCreate: true, channelEdit: true, channelDelete: true,
  channelList: true, channelInfo: true, categoryCreate: true,
  channelMove: true, threadListArchived: true,
  forumTagCreate: true, forumTagDelete: true, forumTagList: true,
  threadEdit: true,
};
export const CHANNEL_ACTION_TYPES = new Set<string>(Object.keys(CHANNEL_TYPE_MAP));

type GuildChannelType = ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildAnnouncement | ChannelType.GuildStageVoice;

const CHANNEL_TYPE_ENUM: Record<string, GuildChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
};

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

      const resolvedType = action.channelType
        ? CHANNEL_TYPE_ENUM[action.channelType]
        : ChannelType.GuildText;
      if (resolvedType === undefined) {
        return { ok: false, error: `Invalid channelType: "${action.channelType}"` };
      }

      const created = await guild.channels.create({
        name: action.name,
        type: resolvedType,
        parent,
        topic: action.topic,
      });
      return { ok: true, summary: `Created #${created.name}${parent ? ` under ${action.parent}` : ''}` };
    }

    case 'channelEdit': {
      if (action.name == null && action.topic == null) {
        return { ok: false, error: 'channelEdit requires at least one of name or topic' };
      }
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      const edits: { name?: string; topic?: string } = {};
      if (action.name != null) edits.name = action.name;
      if (action.topic != null) edits.topic = action.topic;

      await (channel as GuildChannel).edit(edits);
      const parts: string[] = [];
      if (action.name != null) parts.push(`name → ${action.name}`);
      if (action.topic != null) parts.push(`topic updated`);
      return { ok: true, summary: `Edited #${channel.name}: ${parts.join(', ')}` };
    }

    case 'channelDelete': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };
      const name = channel.name;
      await (channel as GuildChannel).delete();
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
          list.push(`#${ch.name} (id:${ch.id})`);
          grouped.set(parentName, list);
        } else {
          uncategorized.push(`#${ch.name} (id:${ch.id})`);
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
      const gc = channel as GuildChannel & { topic?: string; createdAt?: Date };
      if (gc.topic) info.push(`Topic: ${gc.topic}`);
      if (gc.createdAt) info.push(`Created: ${gc.createdAt.toISOString().slice(0, 10)}`);
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

    case 'channelMove': {
      if (action.parent == null && action.position == null) {
        return { ok: false, error: 'channelMove requires at least one of parent or position' };
      }
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      const parts: string[] = [];

      if (action.parent != null) {
        if (action.parent === '') {
          await (channel as GuildChannel).setParent(null);
          parts.push('removed from category');
        } else {
          // Resolve by ID first, then by name (case-insensitive).
          let cat = guild.channels.cache.get(action.parent);
          if (!cat || cat.type !== ChannelType.GuildCategory) {
            cat = guild.channels.cache.find(
              (ch: any) =>
                ch.type === ChannelType.GuildCategory &&
                ch.name.toLowerCase() === action.parent!.toLowerCase(),
            );
          }
          if (!cat) return { ok: false, error: `Category "${action.parent}" not found` };
          await (channel as GuildChannel).setParent(cat.id);
          parts.push(`moved to ${cat.name}`);
        }
      }

      if (action.position != null) {
        await (channel as GuildChannel).setPosition(action.position);
        parts.push(`position → ${action.position}`);
      }

      return { ok: true, summary: `Moved #${channel.name}: ${parts.join(', ')}` };
    }

    case 'threadListArchived': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildText) {
        return { ok: false, error: `Channel #${channel.name} is not a forum or text channel` };
      }

      const limit = action.limit ?? 50;
      const fetched = await (channel as ForumChannel).threads.fetchArchived({ limit, fetchAll: true });
      const threads = [...fetched.threads.values()];

      if (threads.length === 0) {
        return { ok: true, summary: `No archived threads in #${channel.name}` };
      }

      const lines = threads.map((t) => `• ${t.name} (id:${t.id})`);
      return {
        ok: true,
        summary: `Archived threads in #${channel.name} (${threads.length}):\n${lines.join('\n')}`,
      };
    }

    case 'forumTagCreate': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };
      if (channel.type !== ChannelType.GuildForum) {
        return { ok: false, error: `Channel #${channel.name} is not a forum channel` };
      }
      const forum = channel as ForumChannel;
      const existingTags = forum.availableTags ?? [];
      if (existingTags.length >= 20) {
        return { ok: false, error: `Forum #${channel.name} already has 20 tags (Discord maximum)` };
      }
      const newTag: { name: string; emoji?: { id?: string | null; name?: string | null } } = { name: action.name };
      if (action.emoji) {
        newTag.emoji = { id: action.emoji.id ?? null, name: action.emoji.name ?? null };
      }
      const updatedTags = [
        ...existingTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
        newTag,
      ];
      await forum.edit({ availableTags: updatedTags as any });

      // Re-fetch to get the created tag's ID.
      const updated = guild.channels.cache.get(action.channelId) as ForumChannel | undefined;
      const createdTag = updated?.availableTags?.find(
        (t) => t.name.toLowerCase() === action.name.toLowerCase(),
      );
      const tagId = createdTag?.id ?? 'unknown';
      return { ok: true, summary: `Created forum tag "${action.name}" (id:${tagId}) on #${channel.name}` };
    }

    case 'forumTagDelete': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };
      if (channel.type !== ChannelType.GuildForum) {
        return { ok: false, error: `Channel #${channel.name} is not a forum channel` };
      }
      const forum = channel as ForumChannel;
      const existingTags = forum.availableTags ?? [];
      const tagToDelete = existingTags.find((t) => t.id === action.tagId);
      if (!tagToDelete) {
        return { ok: false, error: `Tag "${action.tagId}" not found on forum #${channel.name}` };
      }
      const filteredTags = existingTags
        .filter((t) => t.id !== action.tagId)
        .map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji }));
      await forum.edit({ availableTags: filteredTags as any });
      return { ok: true, summary: `Deleted forum tag "${tagToDelete.name}" (id:${action.tagId}) from #${channel.name}` };
    }

    case 'forumTagList': {
      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };
      if (channel.type !== ChannelType.GuildForum) {
        return { ok: false, error: `Channel #${channel.name} is not a forum channel` };
      }
      const forum = channel as ForumChannel;
      const tags = forum.availableTags ?? [];
      if (tags.length === 0) {
        return { ok: true, summary: `No tags on forum #${channel.name}` };
      }
      const lines = tags.map((t) => {
        const emojiStr = t.emoji?.name ? ` ${t.emoji.name}` : t.emoji?.id ? ` (emoji:${t.emoji.id})` : '';
        return `• ${t.name}${emojiStr} (id:${t.id})`;
      });
      return { ok: true, summary: `Tags on #${channel.name} (${tags.length}):\n${lines.join('\n')}` };
    }

    case 'threadEdit': {
      if (action.appliedTags == null && action.name == null) {
        return { ok: false, error: 'threadEdit requires at least one of appliedTags or name' };
      }

      // Cache-first fetch, same pattern as fetchThreadChannel in task sync.
      let thread: ThreadChannel | null = null;
      const cached = ctx.client.channels.cache.get(action.threadId);
      if (cached && cached.isThread()) {
        thread = cached as ThreadChannel;
      } else {
        try {
          const fetched = await ctx.client.channels.fetch(action.threadId);
          if (fetched && fetched.isThread()) thread = fetched as ThreadChannel;
        } catch {
          // fall through to forum-channel fallback below
        }
      }

      // Fallback: search guild forum channels for the thread.
      // client.channels.fetch() can miss archived forum threads that have
      // been evicted from the gateway cache after archiving.
      // Check archived first (the common case for this fallback), then active.
      if (!thread) {
        for (const ch of guild.channels.cache.values()) {
          if (ch.type !== ChannelType.GuildForum) continue;
          try {
            const archived = await (ch as ForumChannel).threads.fetchArchived({ limit: 100 });
            const archivedMatch = archived.threads.get(action.threadId);
            if (archivedMatch?.isThread()) { thread = archivedMatch as ThreadChannel; break; }
            const active = await (ch as ForumChannel).threads.fetchActive();
            const activeMatch = active.threads.get(action.threadId);
            if (activeMatch?.isThread()) { thread = activeMatch as ThreadChannel; break; }
          } catch {
            // skip forums we can't access
          }
        }
      }

      if (!thread) return { ok: false, error: `Thread "${action.threadId}" not found` };

      if ((thread as any).guildId !== guild.id) {
        return { ok: false, error: `Thread "${action.threadId}" does not belong to this guild` };
      }

      if (action.appliedTags != null) {
        const parentType = (thread as any).parent?.type;
        if (parentType !== ChannelType.GuildForum) {
          return { ok: false, error: `Thread "${action.threadId}" is not in a forum channel — appliedTags only applies to forum threads` };
        }
        if (action.appliedTags.length > 5) {
          return { ok: false, error: `appliedTags exceeds Discord maximum of 5 (got ${action.appliedTags.length})` };
        }
      }

      // Unarchive before editing — Discord rejects edits on archived threads.
      const wasArchived = (thread as any).archived === true;
      if (wasArchived) {
        try { await (thread as any).setArchived(false); } catch { /* proceed — edit may still work */ }
      }

      const edits: { appliedTags?: string[]; name?: string } = {};
      if (action.appliedTags != null) edits.appliedTags = action.appliedTags;
      if (action.name != null) edits.name = action.name;

      await (thread as any).edit(edits);

      // Re-archive if the thread was archived before we touched it.
      let rearchiveFailed = false;
      if (wasArchived) {
        try { await (thread as any).setArchived(true); } catch { rearchiveFailed = true; }
      }

      const parts: string[] = [];
      if (action.name != null) parts.push(`name → ${action.name}`);
      if (action.appliedTags != null) parts.push(`appliedTags → [${action.appliedTags.join(', ')}]`);
      const warning = rearchiveFailed ? ' (warning: failed to re-archive)' : '';
      return { ok: true, summary: `Edited thread "${thread.name}" (id:${thread.id}): ${parts.join(', ')}${warning}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function channelActionsPromptSection(): string {
  return `### Channel Management

**channelCreate** — Create a channel:
\`\`\`
<discord-action>{"type":"channelCreate","name":"channel-name","parent":"Category Name","topic":"Optional topic","channelType":"text"}</discord-action>
\`\`\`
- \`name\` (required): Channel name (lowercase, hyphens, no spaces).
- \`parent\` (optional): Category name to create the channel under.
- \`topic\` (optional): Channel topic description.
- \`channelType\` (optional): \`text\` (default), \`voice\`, \`announcement\`, or \`stage\`.

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
\`\`\`

**channelMove** — Move a channel to a category or position:
\`\`\`
<discord-action>{"type":"channelMove","channelId":"123","parent":"Category Name","position":0}</discord-action>
\`\`\`
- \`channelId\` (required): Channel ID.
- \`parent\` (optional): Category name or ID. Empty string removes from category.
- \`position\` (optional): New position (0-based).
At least one of parent or position is required.

**threadListArchived** — List archived threads in a forum or text channel:
\`\`\`
<discord-action>{"type":"threadListArchived","channelId":"123","limit":25}</discord-action>
\`\`\`
- \`channelId\` (required): The forum or text channel ID.
- \`limit\` (optional): Max threads to return (default 50).

**forumTagCreate** — Create a tag on a forum channel:
\`\`\`
<discord-action>{"type":"forumTagCreate","channelId":"123","name":"open","emoji":{"name":"🟢"}}</discord-action>
\`\`\`
- \`channelId\` (required): The forum channel ID.
- \`name\` (required): Tag name.
- \`emoji\` (optional): Object with \`id\` (custom emoji) or \`name\` (unicode emoji).
Returns the created tag's ID in the summary.

**forumTagDelete** — Delete a tag from a forum channel (destructive — confirm with user first):
\`\`\`
<discord-action>{"type":"forumTagDelete","channelId":"123","tagId":"456"}</discord-action>
\`\`\`
- \`channelId\` (required): The forum channel ID.
- \`tagId\` (required): The tag ID to delete.

**forumTagList** — List all tags on a forum channel:
\`\`\`
<discord-action>{"type":"forumTagList","channelId":"123"}</discord-action>
\`\`\`

**threadEdit** — Edit a forum thread's applied tags and/or name:
\`\`\`
<discord-action>{"type":"threadEdit","threadId":"789","appliedTags":["tag-id-1","tag-id-2"],"name":"New thread name"}</discord-action>
\`\`\`
- \`threadId\` (required): The thread ID (resolved via cache then fetch).
- \`appliedTags\` (optional): Array of tag IDs to apply. Max 5. Only valid for threads in forum channels.
- \`name\` (optional): New thread title.
At least one of appliedTags or name is required.
Use \`forumTagList\` to get tag IDs, then pass them here to swap status tags on orphan threads.`;
}
