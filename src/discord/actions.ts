import type { Client, Guild } from 'discord.js';
import { CHANNEL_ACTION_TYPES, executeChannelAction, channelActionsPromptSection } from './actions-channels.js';
import type { ChannelActionRequest } from './actions-channels.js';
import { MESSAGING_ACTION_TYPES, executeMessagingAction, messagingActionsPromptSection } from './actions-messaging.js';
import type { MessagingActionRequest } from './actions-messaging.js';
import { GUILD_ACTION_TYPES, executeGuildAction, guildActionsPromptSection } from './actions-guild.js';
import type { GuildActionRequest } from './actions-guild.js';
import { MODERATION_ACTION_TYPES, executeModerationAction, moderationActionsPromptSection } from './actions-moderation.js';
import type { ModerationActionRequest } from './actions-moderation.js';
import { POLL_ACTION_TYPES, executePollAction, pollActionsPromptSection } from './actions-poll.js';
import type { PollActionRequest } from './actions-poll.js';
import { BEAD_ACTION_TYPES, executeBeadAction, beadActionsPromptSection } from './actions-beads.js';
import type { BeadActionRequest, BeadContext } from './actions-beads.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionContext = {
  guild: Guild;
  client: Client;
  channelId: string;
  messageId: string;
};

export type ActionCategoryFlags = {
  channels: boolean;
  messaging: boolean;
  guild: boolean;
  moderation: boolean;
  polls: boolean;
  beads: boolean;
};

export type DiscordActionRequest =
  | ChannelActionRequest
  | MessagingActionRequest
  | GuildActionRequest
  | ModerationActionRequest
  | PollActionRequest
  | BeadActionRequest;

export type DiscordActionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

import type { LoggerLike } from './action-types.js';

// ---------------------------------------------------------------------------
// Valid types (union of all sub-module type sets)
// ---------------------------------------------------------------------------

function buildValidTypes(flags: ActionCategoryFlags): Set<string> {
  const types = new Set<string>();
  if (flags.channels) for (const t of CHANNEL_ACTION_TYPES) types.add(t);
  if (flags.messaging) for (const t of MESSAGING_ACTION_TYPES) types.add(t);
  if (flags.guild) for (const t of GUILD_ACTION_TYPES) types.add(t);
  if (flags.moderation) for (const t of MODERATION_ACTION_TYPES) types.add(t);
  if (flags.polls) for (const t of POLL_ACTION_TYPES) types.add(t);
  if (flags.beads) for (const t of BEAD_ACTION_TYPES) types.add(t);
  return types;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ACTION_RE = /<discord-action>([\s\S]*?)<\/discord-action>/g;

export function parseDiscordActions(
  text: string,
  flags: ActionCategoryFlags,
): { cleanText: string; actions: DiscordActionRequest[] } {
  const validTypes = buildValidTypes(flags);
  const actions: DiscordActionRequest[] = [];
  const cleanText = text.replace(ACTION_RE, (_match, json: string) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (parsed && typeof parsed.type === 'string' && validTypes.has(parsed.type)) {
        actions.push(parsed as DiscordActionRequest);
      }
    } catch {
      // Malformed JSON — skip silently.
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, actions };
}

// ---------------------------------------------------------------------------
// Executor (dispatcher)
// ---------------------------------------------------------------------------

export async function executeDiscordActions(
  actions: DiscordActionRequest[],
  ctx: ActionContext,
  log?: LoggerLike,
  beadCtx?: BeadContext,
): Promise<DiscordActionResult[]> {
  const results: DiscordActionResult[] = [];

  for (const action of actions) {
    try {
      let result: DiscordActionResult;

      if (CHANNEL_ACTION_TYPES.has(action.type)) {
        result = await executeChannelAction(action as ChannelActionRequest, ctx);
      } else if (MESSAGING_ACTION_TYPES.has(action.type)) {
        result = await executeMessagingAction(action as MessagingActionRequest, ctx);
      } else if (GUILD_ACTION_TYPES.has(action.type)) {
        result = await executeGuildAction(action as GuildActionRequest, ctx);
      } else if (MODERATION_ACTION_TYPES.has(action.type)) {
        result = await executeModerationAction(action as ModerationActionRequest, ctx);
      } else if (POLL_ACTION_TYPES.has(action.type)) {
        result = await executePollAction(action as PollActionRequest, ctx);
      } else if (BEAD_ACTION_TYPES.has(action.type)) {
        if (!beadCtx) {
          result = { ok: false, error: 'Beads subsystem not configured' };
        } else {
          result = await executeBeadAction(action as BeadActionRequest, ctx, beadCtx);
        }
      } else {
        result = { ok: false, error: `Unknown action type: ${(action as any).type ?? 'unknown'}` };
      }

      results.push(result);
      if (result.ok) {
        log?.info({ action: action.type, summary: result.summary }, `discord:action ${action.type}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, error: msg });
      log?.error({ err, action }, 'discord:action failed');
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function discordActionsPromptSection(flags: ActionCategoryFlags): string {
  const sections: string[] = [];

  sections.push(`## Discord Actions

You can perform Discord server actions by including structured action blocks in your response.`);

  if (flags.messaging) {
    sections.push(messagingActionsPromptSection());
  }

  if (flags.channels) {
    sections.push(channelActionsPromptSection());
  }

  if (flags.guild) {
    sections.push(guildActionsPromptSection());
  }

  if (flags.moderation) {
    sections.push(moderationActionsPromptSection());
  }

  if (flags.polls) {
    sections.push(pollActionsPromptSection());
  }

  if (flags.beads) {
    sections.push(beadActionsPromptSection());
  }

  sections.push(`### Rules
- Only the action types listed above are supported.
- Confirm with the user before performing destructive actions (delete, kick, ban, timeout).
- Action blocks are removed from the displayed message; results are appended automatically.
- Results from information-gathering actions (channelList, channelInfo, threadListArchived, readMessages, fetchMessage, listPins, memberInfo, roleInfo, searchMessages, eventList, beadList, beadShow) are automatically sent back to you for further analysis. You can emit a query action and continue reasoning in the follow-up.
- Include all needed actions in a single response when possible (e.g., a channelList and multiple channelDelete blocks together).

### Permissions
These actions require the bot to have appropriate permissions in this Discord server (e.g. Manage Channels, Manage Roles, Moderate Members). These are server-level role permissions, not Discord Developer Portal settings.

If an action fails with a "Missing Permissions" or "Missing Access" error, tell the user:
1. Open **Server Settings → Roles**.
2. Find the Discoclaw bot's role (usually named after the bot).
3. Enable the required permission under the role's permissions.
4. The bot may need to be re-invited with the "moderator" permission profile if the role wasn't granted at invite time.`);

  return sections.join('\n\n');
}
