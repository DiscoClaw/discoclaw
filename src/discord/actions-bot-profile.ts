import { ActivityType } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BotProfileActionRequest =
  | { type: 'botSetStatus'; status: 'online' | 'idle' | 'dnd' | 'invisible' }
  | { type: 'botSetActivity'; name: string; activityType?: 'Playing' | 'Listening' | 'Watching' | 'Competing' | 'Custom' }
  | { type: 'botSetNickname'; nickname: string };

const BOT_PROFILE_TYPE_MAP: Record<BotProfileActionRequest['type'], true> = {
  botSetStatus: true,
  botSetActivity: true,
  botSetNickname: true,
};
export const BOT_PROFILE_ACTION_TYPES = new Set<string>(Object.keys(BOT_PROFILE_TYPE_MAP));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);

const ACTIVITY_TYPE_MAP: Record<string, ActivityType> = {
  Playing: ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Competing: ActivityType.Competing,
  Custom: ActivityType.Custom,
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeBotProfileAction(
  action: BotProfileActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const { client, guild } = ctx;

  switch (action.type) {
    case 'botSetStatus': {
      if (!VALID_STATUSES.has(action.status)) {
        return { ok: false, error: `Invalid status "${action.status}"; must be one of: online, idle, dnd, invisible` };
      }
      client.user!.setStatus(action.status);
      return { ok: true, summary: `Status set to ${action.status}` };
    }

    case 'botSetActivity': {
      if (!action.name || typeof action.name !== 'string') {
        return { ok: false, error: 'botSetActivity requires a non-empty "name" field' };
      }
      const typeName = action.activityType ?? 'Playing';
      const typeNum = ACTIVITY_TYPE_MAP[typeName];
      if (typeNum === undefined) {
        return { ok: false, error: `Invalid activityType "${typeName}"; must be one of: Playing, Listening, Watching, Competing, Custom` };
      }

      if (typeName === 'Custom') {
        client.user!.setActivity({ name: 'Custom Status', type: ActivityType.Custom, state: action.name });
      } else {
        client.user!.setActivity({ name: action.name, type: typeNum });
      }
      return { ok: true, summary: `Activity set to ${typeName}: ${action.name}` };
    }

    case 'botSetNickname': {
      if (!action.nickname || typeof action.nickname !== 'string') {
        return { ok: false, error: 'botSetNickname requires a non-empty "nickname" field' };
      }
      let me = guild.members.me;
      if (!me) {
        me = await guild.members.fetchMe();
      }
      try {
        await me.setNickname(action.nickname, 'Runtime nickname change via bot profile action');
      } catch (err: any) {
        if (err?.code === 50013) {
          return { ok: false, error: 'Missing Permissions — cannot set nickname (check bot role permissions)' };
        }
        throw err;
      }
      return { ok: true, summary: `Nickname set to "${action.nickname}"` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function botProfileActionsPromptSection(): string {
  return `### Bot Profile

**botSetStatus** — Change the bot's online status:
\`\`\`
<discord-action>{"type":"botSetStatus","status":"idle"}</discord-action>
\`\`\`
- \`status\` (required): One of \`online\`, \`idle\`, \`dnd\`, \`invisible\`.

**botSetActivity** — Set the bot's activity text:
\`\`\`
<discord-action>{"type":"botSetActivity","name":"with beads","activityType":"Playing"}</discord-action>
\`\`\`
- \`name\` (required): The activity text shown in the bot's presence.
- \`activityType\` (optional): One of \`Playing\` (default), \`Listening\`, \`Watching\`, \`Competing\`, \`Custom\`.

**botSetNickname** — Change the bot's nickname in the current server:
\`\`\`
<discord-action>{"type":"botSetNickname","nickname":"Weston"}</discord-action>
\`\`\`
- \`nickname\` (required): The new display name for this server.`;
}
