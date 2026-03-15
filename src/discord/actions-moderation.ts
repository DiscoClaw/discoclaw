import { PermissionFlagsBits } from 'discord.js';
import type { DiscordActionResult, ActionContext, RequesterDenyAll, RequesterMemberContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModerationActionRequest =
  | { type: 'timeout'; userId: string; durationMinutes?: number; reason?: string }
  | { type: 'kick'; userId: string; reason?: string }
  | { type: 'ban'; userId: string; reason?: string; deleteMessageDays?: number };

const MODERATION_TYPE_MAP: Record<ModerationActionRequest['type'], true> = {
  timeout: true, kick: true, ban: true,
};
export const MODERATION_ACTION_TYPES = new Set<string>(Object.keys(MODERATION_TYPE_MAP));

function isRequesterDenyAll(
  requesterMember: RequesterMemberContext,
): requesterMember is RequesterDenyAll {
  return Boolean(requesterMember && typeof requesterMember === 'object' && '__requesterDenyAll' in requesterMember);
}

function permissionDenied(action: ModerationActionRequest['type']): DiscordActionResult {
  return { ok: false, error: `Permission denied for ${action}` };
}

function highestRolePosition(member: { roles?: { highest?: { position?: number } } }): number {
  return typeof member.roles?.highest?.position === 'number' ? member.roles.highest.position : 0;
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

export async function executeModerationAction(
  action: ModerationActionRequest,
  ctx: ActionContext,
  requesterMember?: RequesterMemberContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;
  if (isRequesterDenyAll(requesterMember)) {
    return permissionDenied(action.type);
  }
  const enforcingRequester = requesterMember && !isRequesterDenyAll(requesterMember)
    ? requesterMember
    : undefined;

  switch (action.type) {
    case 'timeout': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      if (enforcingRequester) {
        if (!requesterHasGuildPermission(enforcingRequester, PermissionFlagsBits.ModerateMembers)) {
          return permissionDenied(action.type);
        }
        if (highestRolePosition(enforcingRequester) <= highestRolePosition(member)) {
          return permissionDenied(action.type);
        }
      }
      const minutes = action.durationMinutes ?? 5;
      const ms = minutes * 60 * 1000;
      await member.timeout(ms, action.reason);
      return { ok: true, summary: `Timed out ${member.displayName} for ${minutes} minutes${action.reason ? `: ${action.reason}` : ''}` };
    }

    case 'kick': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      if (enforcingRequester) {
        if (!requesterHasGuildPermission(enforcingRequester, PermissionFlagsBits.KickMembers)) {
          return permissionDenied(action.type);
        }
        if (highestRolePosition(enforcingRequester) <= highestRolePosition(member)) {
          return permissionDenied(action.type);
        }
      }
      const name = member.displayName;
      await member.kick(action.reason);
      return { ok: true, summary: `Kicked ${name}${action.reason ? `: ${action.reason}` : ''}` };
    }

    case 'ban': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      if (enforcingRequester) {
        if (!requesterHasGuildPermission(enforcingRequester, PermissionFlagsBits.BanMembers)) {
          return permissionDenied(action.type);
        }
        if (highestRolePosition(enforcingRequester) <= highestRolePosition(member)) {
          return permissionDenied(action.type);
        }
      }
      const name = member.displayName;
      await member.ban({
        reason: action.reason,
        deleteMessageSeconds: (action.deleteMessageDays ?? 0) * 86400,
      });
      return { ok: true, summary: `Banned ${name}${action.reason ? `: ${action.reason}` : ''}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function moderationActionsPromptSection(): string {
  return `### Moderation

All moderation actions are destructive. **Always confirm with the user before executing.**

**timeout** — Temporarily mute a member:
\`\`\`
<discord-action>{"type":"timeout","userId":"123","durationMinutes":10,"reason":"Spamming"}</discord-action>
\`\`\`
- \`durationMinutes\` (optional): Default 5 minutes.

**kick** — Kick a member from the server:
\`\`\`
<discord-action>{"type":"kick","userId":"123","reason":"Rule violation"}</discord-action>
\`\`\`

**ban** — Ban a member from the server:
\`\`\`
<discord-action>{"type":"ban","userId":"123","reason":"Repeated violations","deleteMessageDays":1}</discord-action>
\`\`\`
- \`deleteMessageDays\` (optional): Delete messages from the last N days (0–7).`;
}
