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
import { CRON_ACTION_TYPES, executeCronAction, cronActionsPromptSection } from './actions-crons.js';
import type { CronActionRequest, CronContext } from './actions-crons.js';
import { BOT_PROFILE_ACTION_TYPES, executeBotProfileAction, botProfileActionsPromptSection } from './actions-bot-profile.js';
import type { BotProfileActionRequest } from './actions-bot-profile.js';
import { FORGE_ACTION_TYPES, executeForgeAction, forgeActionsPromptSection } from './actions-forge.js';
import type { ForgeActionRequest, ForgeContext } from './actions-forge.js';
import { PLAN_ACTION_TYPES, executePlanAction, planActionsPromptSection } from './actions-plan.js';
import type { PlanActionRequest, PlanContext } from './actions-plan.js';
import { MEMORY_ACTION_TYPES, executeMemoryAction, memoryActionsPromptSection } from './actions-memory.js';
import type { MemoryActionRequest, MemoryContext } from './actions-memory.js';
import { DEFER_ACTION_TYPES, executeDeferAction } from './actions-defer.js';
import type { DeferActionRequest } from './actions-defer.js';
import type { DeferScheduler } from './defer-scheduler.js';
import { CONFIG_ACTION_TYPES, executeConfigAction, configActionsPromptSection } from './actions-config.js';
import type { ConfigActionRequest, ConfigContext } from './actions-config.js';
import { executeReactionPromptAction as executeReactionPrompt, REACTION_PROMPT_ACTION_TYPES, reactionPromptSection } from './reaction-prompts.js';
import type { ReactionPromptRequest } from './reaction-prompts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionContext = {
  guild: Guild;
  client: Client;
  channelId: string;
  messageId: string;
  threadParentId?: string | null;
  deferScheduler?: DeferScheduler<DeferActionRequest, ActionContext>;
};

export type ActionCategoryFlags = {
  channels: boolean;
  messaging: boolean;
  guild: boolean;
  moderation: boolean;
  polls: boolean;
  beads: boolean;
  crons: boolean;
  botProfile: boolean;
  forge: boolean;
  plan: boolean;
  memory: boolean;
  defer: boolean;
  config: boolean;
};

export type DiscordActionRequest =
  | ChannelActionRequest
  | MessagingActionRequest
  | GuildActionRequest
  | ModerationActionRequest
  | PollActionRequest
  | BeadActionRequest
  | CronActionRequest
  | BotProfileActionRequest
  | ForgeActionRequest
  | PlanActionRequest
  | MemoryActionRequest
  | DeferActionRequest
  | ConfigActionRequest
  | ReactionPromptRequest;

export type DiscordActionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

import type { LoggerLike } from './action-types.js';

export type SubsystemContexts = {
  beadCtx?: BeadContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  configCtx?: ConfigContext;
};

// ---------------------------------------------------------------------------
// Valid types (union of all sub-module type sets)
// ---------------------------------------------------------------------------

function buildValidTypes(flags: ActionCategoryFlags): Set<string> {
  const types = new Set<string>();
  if (flags.channels) for (const t of CHANNEL_ACTION_TYPES) types.add(t);
  if (flags.messaging) for (const t of MESSAGING_ACTION_TYPES) types.add(t);
  if (flags.messaging) for (const t of REACTION_PROMPT_ACTION_TYPES) types.add(t);
  if (flags.guild) for (const t of GUILD_ACTION_TYPES) types.add(t);
  if (flags.moderation) for (const t of MODERATION_ACTION_TYPES) types.add(t);
  if (flags.polls) for (const t of POLL_ACTION_TYPES) types.add(t);
  if (flags.beads) for (const t of BEAD_ACTION_TYPES) types.add(t);
  if (flags.crons) for (const t of CRON_ACTION_TYPES) types.add(t);
  if (flags.botProfile) for (const t of BOT_PROFILE_ACTION_TYPES) types.add(t);
  if (flags.forge) for (const t of FORGE_ACTION_TYPES) types.add(t);
  if (flags.plan) for (const t of PLAN_ACTION_TYPES) types.add(t);
  if (flags.memory) for (const t of MEMORY_ACTION_TYPES) types.add(t);
  if (flags.defer) for (const t of DEFER_ACTION_TYPES) types.add(t);
  if (flags.config) for (const t of CONFIG_ACTION_TYPES) types.add(t);
  return types;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ACTION_RE = /<discord-action>([\s\S]*?)<\/discord-action>/g;

// Trailing XML closing tags left by garbled AI output (e.g. </parameter>\n</invoke>).
const TRAILING_XML_RE = /^(?:\s*<\/[a-z-]+>)+/;

/**
 * Extract a JSON object starting at `text[start]` (which must be '{') by
 * counting brace depth, respecting string literals. Returns the substring
 * including the outer braces, or null if braces never balance.
 */
function extractJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * Second-pass scanner for malformed `<discord-action>` blocks whose closing
 * tag is wrong or missing (e.g. `</parameter>\n</invoke>` instead of
 * `</discord-action>`).  Uses brace-counting to reliably extract the JSON
 * object regardless of nested braces in string values, then consumes any
 * trailing XML-like closing tags.
 */
function stripMalformedActions(
  text: string,
  validTypes: Set<string>,
  actions: DiscordActionRequest[],
  strippedUnrecognizedTypes: string[],
): string {
  const MARKER = '<discord-action>';
  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const idx = text.indexOf(MARKER, cursor);
    if (idx === -1) { result += text.slice(cursor); break; }

    // Copy text before the marker.
    result += text.slice(cursor, idx);

    // Find the opening brace after the marker.
    let afterMarker = idx + MARKER.length;
    // Skip whitespace between marker and brace.
    while (afterMarker < text.length && /\s/.test(text[afterMarker])) afterMarker++;

    if (afterMarker >= text.length || text[afterMarker] !== '{') {
      // No JSON object follows — keep the marker text as-is and move on.
      result += MARKER;
      cursor = idx + MARKER.length;
      continue;
    }

    const jsonStr = extractJsonObject(text, afterMarker);
    if (!jsonStr) {
      // Unbalanced braces — strip this line, then consume any trailing XML closing tags.
      const nl = text.indexOf('\n', afterMarker);
      cursor = nl === -1 ? text.length : nl;
      const trailing = text.slice(cursor).match(TRAILING_XML_RE);
      if (trailing) cursor += trailing[0].length;
      continue;
    }

    // Try to parse and collect the action.
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed.type === 'string') {
        if (validTypes.has(parsed.type)) {
          actions.push(parsed as DiscordActionRequest);
        } else {
          strippedUnrecognizedTypes.push(parsed.type);
        }
      }
    } catch {
      // Malformed JSON — strip it from display anyway.
    }

    // Advance past the JSON object and consume any trailing XML closing tags.
    cursor = afterMarker + jsonStr.length;
    const trailing = text.slice(cursor).match(TRAILING_XML_RE);
    if (trailing) cursor += trailing[0].length;
  }

  return result;
}

export function parseDiscordActions(
  text: string,
  flags: ActionCategoryFlags,
): { cleanText: string; actions: DiscordActionRequest[]; strippedUnrecognizedTypes: string[] } {
  const validTypes = buildValidTypes(flags);
  const actions: DiscordActionRequest[] = [];
  const strippedUnrecognizedTypes: string[] = [];

  // First pass: well-formed <discord-action>...</discord-action> blocks.
  let cleaned = text.replace(ACTION_RE, (_match, json: string) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (parsed && typeof parsed.type === 'string') {
        if (validTypes.has(parsed.type)) {
          actions.push(parsed as DiscordActionRequest);
        } else {
          strippedUnrecognizedTypes.push(parsed.type);
        }
      }
    } catch {
      // Malformed JSON — skip silently.
    }
    return '';
  });

  // Second pass: malformed blocks (wrong closing tag or no closing tag).
  cleaned = stripMalformedActions(cleaned, validTypes, actions, strippedUnrecognizedTypes);

  const cleanText = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, actions, strippedUnrecognizedTypes };
}

// ---------------------------------------------------------------------------
// Executor (dispatcher)
// ---------------------------------------------------------------------------

export async function executeDiscordActions(
  actions: DiscordActionRequest[],
  ctx: ActionContext,
  log?: LoggerLike,
  beadCtxOrSubs?: BeadContext | SubsystemContexts,
  cronCtx?: CronContext,
): Promise<DiscordActionResult[]> {
  // Support both legacy positional args and new bag-style call.
  let subs: SubsystemContexts;
  if (beadCtxOrSubs && typeof beadCtxOrSubs === 'object' && 'beadCtx' in beadCtxOrSubs) {
    subs = beadCtxOrSubs;
  } else {
    subs = { beadCtx: beadCtxOrSubs as BeadContext | undefined, cronCtx };
  }

  const results: DiscordActionResult[] = [];

  for (const action of actions) {
    try {
      let result: DiscordActionResult;

      if (CHANNEL_ACTION_TYPES.has(action.type)) {
        result = await executeChannelAction(action as ChannelActionRequest, ctx);
      } else if (MESSAGING_ACTION_TYPES.has(action.type)) {
        result = await executeMessagingAction(action as MessagingActionRequest, ctx);
      } else if (REACTION_PROMPT_ACTION_TYPES.has(action.type)) {
        result = await executeReactionPrompt(action as ReactionPromptRequest, ctx);
      } else if (GUILD_ACTION_TYPES.has(action.type)) {
        result = await executeGuildAction(action as GuildActionRequest, ctx);
      } else if (MODERATION_ACTION_TYPES.has(action.type)) {
        result = await executeModerationAction(action as ModerationActionRequest, ctx);
      } else if (POLL_ACTION_TYPES.has(action.type)) {
        result = await executePollAction(action as PollActionRequest, ctx);
      } else if (BEAD_ACTION_TYPES.has(action.type)) {
        if (!subs.beadCtx) {
          result = { ok: false, error: 'Beads subsystem not configured' };
        } else {
          result = await executeBeadAction(action as BeadActionRequest, ctx, subs.beadCtx);
        }
      } else if (CRON_ACTION_TYPES.has(action.type)) {
        if (!subs.cronCtx) {
          result = { ok: false, error: 'Cron subsystem not configured' };
        } else {
          result = await executeCronAction(action as CronActionRequest, ctx, subs.cronCtx);
        }
      } else if (BOT_PROFILE_ACTION_TYPES.has(action.type)) {
        result = await executeBotProfileAction(action as BotProfileActionRequest, ctx);
      } else if (FORGE_ACTION_TYPES.has(action.type)) {
        if (!subs.forgeCtx) {
          result = { ok: false, error: 'Forge subsystem not configured' };
        } else {
          result = await executeForgeAction(action as ForgeActionRequest, ctx, subs.forgeCtx);
        }
      } else if (PLAN_ACTION_TYPES.has(action.type)) {
        if (!subs.planCtx) {
          result = { ok: false, error: 'Plan subsystem not configured' };
        } else {
          result = await executePlanAction(action as PlanActionRequest, ctx, subs.planCtx);
        }
      } else if (MEMORY_ACTION_TYPES.has(action.type)) {
        if (!subs.memoryCtx) {
          result = { ok: false, error: 'Memory subsystem not configured' };
        } else {
          result = await executeMemoryAction(action as MemoryActionRequest, ctx, subs.memoryCtx);
        }
      } else if (DEFER_ACTION_TYPES.has(action.type)) {
        result = await executeDeferAction(action as DeferActionRequest, ctx);
      } else if (CONFIG_ACTION_TYPES.has(action.type)) {
        if (!subs.configCtx) {
          result = { ok: false, error: 'Config subsystem not configured' };
        } else {
          result = executeConfigAction(action as ConfigActionRequest, subs.configCtx);
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
// Result-line helpers
// ---------------------------------------------------------------------------

/**
 * Build result lines for display in Discord (posted message).
 * Suppresses successful sendMessage results since the sent message
 * is its own confirmation.
 */
export function buildDisplayResultLines(
  actions: { type: string }[],
  results: DiscordActionResult[],
): string[] {
  return results
    .map((r, i) => {
      if (r.ok && actions[i]?.type === 'sendMessage') return null;
      return r.ok ? `Done: ${r.summary}` : `Failed: ${r.error}`;
    })
    .filter((line): line is string => line !== null);
}

/**
 * Build result lines for follow-up prompts (AI sees all results).
 */
export function buildAllResultLines(
  results: DiscordActionResult[],
): string[] {
  return results.map((r) =>
    r.ok ? `Done: ${r.summary}` : `Failed: ${r.error}`,
  );
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function discordActionsPromptSection(flags: ActionCategoryFlags, botDisplayName?: string): string {
  const displayName = botDisplayName ?? 'Discoclaw';
  const sections: string[] = [];

  sections.push(`## Discord Actions

Setting DISCOCLAW_DISCORD_ACTIONS=1 publishes this standard guidance (even if only a subset of sub-categories are available). You can perform Discord server actions by including structured action blocks in your response.`);

  if (flags.messaging) {
    sections.push(messagingActionsPromptSection());
    sections.push(reactionPromptSection());
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

  if (flags.crons) {
    sections.push(cronActionsPromptSection());
  }

  if (flags.botProfile) {
    sections.push(botProfileActionsPromptSection());
  }

  if (flags.forge) {
    sections.push(forgeActionsPromptSection());
  }

  if (flags.plan) {
    sections.push(planActionsPromptSection());
  }

  if (flags.memory) {
    sections.push(memoryActionsPromptSection());
  }

  if (flags.config) {
    sections.push(configActionsPromptSection());
  }

  sections.push(`### Rules
- Only the action types listed above are supported.
- Never emit an action with empty, placeholder, or missing values for required parameters. If you don't have the value (e.g., no messageId for react), skip the action entirely.
- Confirm with the user before performing destructive actions (delete, kick, ban, timeout).
- Action blocks are removed from the displayed message; results are appended automatically.
- Results from information-gathering actions (channelList, channelInfo, threadListArchived, forumTagList, readMessages, fetchMessage, listPins, memberInfo, roleInfo, searchMessages, eventList, beadList, beadShow, cronList, cronShow, planList, planShow, memoryShow, modelShow) are automatically sent back to you for further analysis. You can emit a query action and continue reasoning in the follow-up.
- Include all needed actions in a single response when possible (e.g., a channelList and multiple channelDelete blocks together).

### Permissions
These actions require the bot to have appropriate permissions in this Discord server (e.g. Manage Channels, Manage Roles, Moderate Members). These are server-level role permissions, not Discord Developer Portal settings.

If an action fails with a "Missing Permissions" or "Missing Access" error, tell the user:
1. Open **Server Settings → Roles**.
2. Find the ${displayName} bot's role (usually named after the bot).
3. Enable the required permission under the role's permissions.
4. The bot may need to be re-invited with the "moderator" permission profile if the role wasn't granted at invite time.`);

  if (flags.defer) {
    sections.push(`### Deferred self-invocation
Use a <discord-action>{"type":"defer","channel":"general","delaySeconds":600,"prompt":"Check on the forge run"}</discord-action> block to schedule a follow-up run inside the requested channel without another user prompt. You must specify the channel by name or ID; delaySeconds is how long to wait (capped by DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS) and prompt becomes the user message when the deferred invocation runs. The scheduler enforces DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT pending jobs, respects the same channel permissions as this response, automatically posts the follow-up output, and forces \`defer\` off during that run so no chains can form. If a guard rail rejects the request (too long, too many active defers, missing permissions, or the channel becomes invalid) the action fails with an explanatory message.`);

  }

  return sections.join('\n\n');
}
