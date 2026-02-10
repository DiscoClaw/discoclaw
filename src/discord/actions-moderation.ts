import type { DiscordActionResult, ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModerationActionRequest =
  | { type: 'timeout'; userId: string; durationMinutes?: number; reason?: string }
  | { type: 'kick'; userId: string; reason?: string }
  | { type: 'ban'; userId: string; reason?: string; deleteMessageDays?: number };

export const MODERATION_ACTION_TYPES = new Set(['timeout', 'kick', 'ban']);

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeModerationAction(
  action: ModerationActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;

  switch (action.type) {
    case 'timeout': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      const minutes = action.durationMinutes ?? 5;
      const ms = minutes * 60 * 1000;
      await member.timeout(ms, action.reason);
      return { ok: true, summary: `Timed out ${member.displayName} for ${minutes} minutes${action.reason ? `: ${action.reason}` : ''}` };
    }

    case 'kick': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
      const name = member.displayName;
      await member.kick(action.reason);
      return { ok: true, summary: `Kicked ${name}${action.reason ? `: ${action.reason}` : ''}` };
    }

    case 'ban': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return { ok: false, error: `Member "${action.userId}" not found` };
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
