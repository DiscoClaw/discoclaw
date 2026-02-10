import type { Client, Guild } from 'discord.js';
import { CHANNEL_ACTION_TYPES, executeChannelAction, channelActionsPromptSection } from './actions-channels.js';
import type { ChannelActionRequest } from './actions-channels.js';
import { MESSAGING_ACTION_TYPES, executeMessagingAction, messagingActionsPromptSection } from './actions-messaging.js';
import type { MessagingActionRequest } from './actions-messaging.js';

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
};

export type DiscordActionRequest =
  | ChannelActionRequest
  | MessagingActionRequest;

export type DiscordActionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

type LoggerLike = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

// ---------------------------------------------------------------------------
// Valid types (union of all sub-module type sets)
// ---------------------------------------------------------------------------

function buildValidTypes(flags: ActionCategoryFlags): Set<string> {
  const types = new Set<string>();
  if (flags.channels) for (const t of CHANNEL_ACTION_TYPES) types.add(t);
  if (flags.messaging) for (const t of MESSAGING_ACTION_TYPES) types.add(t);
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
  });

  return { cleanText, actions };
}

// ---------------------------------------------------------------------------
// Executor (dispatcher)
// ---------------------------------------------------------------------------

export async function executeDiscordActions(
  actions: DiscordActionRequest[],
  ctx: ActionContext,
  log?: LoggerLike,
): Promise<DiscordActionResult[]> {
  const results: DiscordActionResult[] = [];

  for (const action of actions) {
    try {
      let result: DiscordActionResult;

      if (CHANNEL_ACTION_TYPES.has(action.type)) {
        result = await executeChannelAction(action as ChannelActionRequest, ctx);
      } else if (MESSAGING_ACTION_TYPES.has(action.type)) {
        result = await executeMessagingAction(action as MessagingActionRequest, ctx);
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

  sections.push(`### Rules
- Only the action types listed above are supported.
- Confirm with the user before performing destructive actions (delete, kick, ban, timeout).
- Action blocks are removed from the displayed message; results are appended automatically.

### Permissions
These actions require the bot to have appropriate permissions in this Discord server (e.g. Manage Channels, Manage Roles, Moderate Members). These are server-level role permissions, not Discord Developer Portal settings.

If an action fails with a "Missing Permissions" or "Missing Access" error, tell the user:
1. Open **Server Settings → Roles**.
2. Find the Discoclaw bot's role (usually named after the bot).
3. Enable the required permission under the role's permissions.
4. The bot may need to be re-invited with the "moderator" permission profile if the role wasn't granted at invite time.`);

  return sections.join('\n\n');
}
