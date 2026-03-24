import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildChannel } from 'discord.js';
import type { DiscordActionResult, ActionContext, RequesterDenyAll, RequesterMemberContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArchiveActionRequest =
  | { type: 'archiveChannel'; channelId: string; archiveCategoryName?: string; lock?: boolean }
  | { type: 'unarchiveChannel'; channelId: string; targetCategory?: string }
  | { type: 'archiveList'; archiveCategoryName?: string };

const ARCHIVE_TYPE_MAP: Record<ArchiveActionRequest['type'], true> = {
  archiveChannel: true,
  unarchiveChannel: true,
  archiveList: true,
};
export const ARCHIVE_ACTION_TYPES = new Set<string>(Object.keys(ARCHIVE_TYPE_MAP));

const DEFAULT_ARCHIVE_CATEGORY_NAME = 'Archive';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRequesterDenyAll(
  requesterMember: RequesterMemberContext,
): requesterMember is RequesterDenyAll {
  return Boolean(requesterMember && typeof requesterMember === 'object' && '__requesterDenyAll' in requesterMember);
}

function permissionDenied(action: ArchiveActionRequest['type']): DiscordActionResult {
  return { ok: false, error: `Permission denied for ${action}` };
}

function requesterHasGuildPermission(
  requesterMember: Exclude<RequesterMemberContext, RequesterDenyAll | undefined>,
  permission: bigint,
): boolean {
  return Boolean(
    (requesterMember as { permissions?: { has?: (perm: bigint) => boolean } }).permissions?.has?.(permission),
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeArchiveAction(
  action: ArchiveActionRequest,
  ctx: ActionContext,
  requesterMember?: RequesterMemberContext,
): Promise<DiscordActionResult> {
  if (isRequesterDenyAll(requesterMember)) {
    return permissionDenied(action.type);
  }

  const { guild } = ctx;
  const enforcingRequester = requesterMember && !isRequesterDenyAll(requesterMember)
    ? requesterMember
    : undefined;

  const archiveCatName = ('archiveCategoryName' in action && action.archiveCategoryName)
    ? action.archiveCategoryName
    : DEFAULT_ARCHIVE_CATEGORY_NAME;

  switch (action.type) {
    case 'archiveChannel': {
      if (enforcingRequester && !requesterHasGuildPermission(enforcingRequester, PermissionFlagsBits.ManageChannels)) {
        return permissionDenied(action.type);
      }

      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      // Find or create the archive category.
      let archiveCat = guild.channels.cache.find(
        (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === archiveCatName.toLowerCase(),
      );
      if (!archiveCat) {
        archiveCat = await guild.channels.create({ name: archiveCatName, type: ChannelType.GuildCategory });
      }

      await (channel as GuildChannel).setParent(archiveCat.id, { lockPermissions: false });

      const parts: string[] = [`Archived #${(channel as GuildChannel).name} to "${archiveCat.name}"`];

      if (action.lock) {
        await (channel as GuildChannel).permissionOverwrites?.edit(guild.roles.everyone, {
          SendMessages: false,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
        });
        parts.push('(locked read-only)');
      }

      return { ok: true, summary: parts.join(' ') };
    }

    case 'unarchiveChannel': {
      if (enforcingRequester && !requesterHasGuildPermission(enforcingRequester, PermissionFlagsBits.ManageChannels)) {
        return permissionDenied(action.type);
      }

      const channel = guild.channels.cache.get(action.channelId);
      if (!channel) return { ok: false, error: `Channel "${action.channelId}" not found` };

      let targetParentId: string | null = null;
      if (action.targetCategory) {
        // Resolve by ID first, then name.
        const cat = guild.channels.cache.get(action.targetCategory)
          ?? guild.channels.cache.find(
            (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === action.targetCategory!.toLowerCase(),
          );
        if (!cat) return { ok: false, error: `Target category "${action.targetCategory}" not found` };
        targetParentId = cat.id;
      }

      await (channel as GuildChannel).setParent(targetParentId, { lockPermissions: false });

      // Remove any read-only override applied by archiveChannel.
      await (channel as GuildChannel).permissionOverwrites?.delete(guild.roles.everyone);

      const dest = action.targetCategory ? `"${action.targetCategory}"` : 'no category';
      return { ok: true, summary: `Unarchived #${(channel as GuildChannel).name} → ${dest}` };
    }

    case 'archiveList': {
      const archiveCat = guild.channels.cache.find(
        (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === archiveCatName.toLowerCase(),
      );
      if (!archiveCat) {
        return { ok: true, summary: `No archive category named "${archiveCatName}" found` };
      }

      const archived = guild.channels.cache
        .filter((ch) => 'parentId' in ch && (ch as GuildChannel).parentId === archiveCat.id)
        .map((ch) => `#${(ch as GuildChannel).name} (${ch.id})`)
        .sort();

      if (archived.length === 0) {
        return { ok: true, summary: `Archive category "${archiveCat.name}" is empty` };
      }

      return { ok: true, summary: `Channels in "${archiveCat.name}":\n${archived.join('\n')}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function archiveActionsPromptSection(): string {
  return `### Archive

**archiveChannel** — \`{"type":"archiveChannel","channelId":"123","lock":false}\`
\`channelId\` required. \`archiveCategoryName\` (default "Archive"), \`lock\` (true=read-only) optional.

**unarchiveChannel** — \`{"type":"unarchiveChannel","channelId":"123","targetCategory":"General"}\`
\`targetCategory\` optional (omit to leave uncategorised).

**archiveList** — \`{"type":"archiveList"}\``;
}
