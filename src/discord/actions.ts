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
import {
  executeTaskAction,
  TASK_ACTION_TYPES,
  isTaskActionRequest,
  taskActionsPromptSection,
} from '../tasks/task-actions.js';
import type { TaskActionRequest } from '../tasks/task-actions.js';
import type { TaskContext } from '../tasks/task-context.js';
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
import { IMAGEGEN_ACTION_TYPES, executeImagegenAction, imagegenActionsPromptSection } from './actions-imagegen.js';
import type { ImagegenActionRequest, ImagegenContext } from './actions-imagegen.js';
import { describeDestructiveConfirmationRequirement } from './destructive-confirmation.js';

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
  confirmation?: {
    mode: 'interactive' | 'automated';
    sessionKey?: string;
    userId?: string;
    bypassDestructive?: boolean;
  };
};

export type ActionCategoryFlags = {
  channels: boolean;
  messaging: boolean;
  guild: boolean;
  moderation: boolean;
  polls: boolean;
  tasks: boolean;
  crons: boolean;
  botProfile: boolean;
  forge: boolean;
  plan: boolean;
  memory: boolean;
  defer: boolean;
  config: boolean;
  imagegen?: boolean;
};

export type DiscordActionRequest =
  | ChannelActionRequest
  | MessagingActionRequest
  | GuildActionRequest
  | ModerationActionRequest
  | PollActionRequest
  | TaskActionRequest
  | CronActionRequest
  | BotProfileActionRequest
  | ForgeActionRequest
  | PlanActionRequest
  | MemoryActionRequest
  | DeferActionRequest
  | ConfigActionRequest
  | ReactionPromptRequest
  | ImagegenActionRequest;

export type DiscordActionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

import type { LoggerLike } from '../logging/logger-like.js';

export type SubsystemContexts = {
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  configCtx?: ConfigContext;
  imagegenCtx?: ImagegenContext;
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
  if (flags.tasks) for (const t of TASK_ACTION_TYPES) types.add(t);
  if (flags.crons) for (const t of CRON_ACTION_TYPES) types.add(t);
  if (flags.botProfile) for (const t of BOT_PROFILE_ACTION_TYPES) types.add(t);
  if (flags.forge) for (const t of FORGE_ACTION_TYPES) types.add(t);
  if (flags.plan) for (const t of PLAN_ACTION_TYPES) types.add(t);
  if (flags.memory) for (const t of MEMORY_ACTION_TYPES) types.add(t);
  if (flags.defer) for (const t of DEFER_ACTION_TYPES) types.add(t);
  if (flags.config) for (const t of CONFIG_ACTION_TYPES) types.add(t);
  if (flags.imagegen) for (const t of IMAGEGEN_ACTION_TYPES) types.add(t);
  return types;
}

function rewriteLegacyPlanCloseToTaskClose(
  parsed: { type?: unknown; planId?: unknown },
  flags: ActionCategoryFlags,
): TaskActionRequest | null {
  if (parsed.type !== 'planClose') return null;
  if (flags.plan || !flags.tasks) return null;
  if (typeof parsed.planId !== 'string') return null;

  const id = parsed.planId.trim();
  if (!id) return null;

  // Keep true plan IDs untouched; only recover task-like IDs.
  if (/^plan-\d+$/i.test(id)) return null;

  return { type: 'taskClose', taskId: id };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ACTION_RE = /<discord-action>([\s\S]*?)<\/discord-action>/g;
const ACTION_OPEN = '<discord-action>';
const ACTION_CLOSE = '</discord-action>';

// Trailing XML closing tags left by garbled AI output (e.g. </parameter>\n</invoke>).
const TRAILING_XML_RE = /^(?:\s*<\/[a-z-]+>)+/;

type TextRange = { start: number; end: number };

function mergeRanges(ranges: TextRange[]): TextRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ start: cur.start, end: cur.end });
    }
  }
  return merged;
}

function isIndexInRanges(index: number, ranges: TextRange[]): boolean {
  for (const range of ranges) {
    if (index < range.start) return false;
    if (index < range.end) return true;
  }
  return false;
}

function computeMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];

  // 1) Fenced code blocks (``` and ~~~)
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const hasNl = nl !== -1;
    const lineEnd = hasNl ? nl : text.length;
    const lineEndWithNl = hasNl ? nl + 1 : text.length;
    const line = text.slice(lineStart, lineEnd);
    if (!inFence) {
      const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (open) {
        inFence = true;
        fenceChar = open[1][0]!;
        fenceLen = open[1].length;
        fenceStart = lineStart;
      }
    } else {
      const closeRe = new RegExp(`^[ \\t]*\\${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(line)) {
        ranges.push({ start: fenceStart, end: lineEndWithNl });
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
    if (!hasNl) break;
    lineStart = lineEndWithNl;
  }
  if (inFence) {
    ranges.push({ start: fenceStart, end: text.length });
  }

  // 2) Indented code blocks outside fenced blocks.
  const mergedFence = mergeRanges(ranges);
  let segStart = 0;
  for (const fence of mergedFence) {
    if (segStart < fence.start) {
      collectIndentedCodeRanges(text, segStart, fence.start, ranges);
    }
    segStart = fence.end;
  }
  if (segStart < text.length) {
    collectIndentedCodeRanges(text, segStart, text.length, ranges);
  }

  // 3) Inline code spans (`...`) outside fenced/indented code blocks.
  const mergedBlock = mergeRanges(ranges);
  segStart = 0;
  for (const block of mergedBlock) {
    if (segStart < block.start) {
      collectInlineCodeRanges(text, segStart, block.start, ranges);
    }
    segStart = block.end;
  }
  if (segStart < text.length) {
    collectInlineCodeRanges(text, segStart, text.length, ranges);
  }

  return mergeRanges(ranges);
}

function collectIndentedCodeRanges(text: string, start: number, end: number, out: TextRange[]): void {
  let lineStart = start;
  let blockStart = -1;
  let blockEnd = -1;

  while (lineStart <= end) {
    const nl = text.indexOf('\n', lineStart);
    const hasNl = nl !== -1 && nl < end;
    const lineEnd = hasNl ? nl : end;
    const lineEndWithNl = hasNl ? nl + 1 : end;
    const line = text.slice(lineStart, lineEnd);
    const isBlank = /^[ \t]*$/.test(line);
    const isIndented = /^(?: {4,}|\t)/.test(line);

    if (blockStart === -1) {
      if (isIndented && !isBlank) {
        blockStart = lineStart;
        blockEnd = lineEndWithNl;
      }
    } else if (isIndented || isBlank) {
      if (isIndented) blockEnd = lineEndWithNl;
    } else {
      out.push({ start: blockStart, end: blockEnd });
      blockStart = -1;
      blockEnd = -1;
    }

    if (!hasNl) break;
    lineStart = lineEndWithNl;
  }

  if (blockStart !== -1) {
    out.push({ start: blockStart, end: blockEnd });
  }
}

function collectInlineCodeRanges(text: string, start: number, end: number, out: TextRange[]): void {
  let i = start;
  let inInline = false;
  let inlineTicks = 0;
  let inlineStart = -1;
  while (i < end) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let ticks = 1;
    while (i + ticks < end && text[i + ticks] === '`') ticks++;
    if (!inInline) {
      inInline = true;
      inlineTicks = ticks;
      inlineStart = i;
    } else if (ticks === inlineTicks) {
      out.push({ start: inlineStart, end: i + ticks });
      inInline = false;
      inlineTicks = 0;
      inlineStart = -1;
    }
    i += ticks;
  }
}

function findNextActionOpenOutsideCode(text: string, from: number, codeRanges: TextRange[]): number {
  let idx = text.indexOf(ACTION_OPEN, from);
  while (idx !== -1) {
    if (!isIndexInRanges(idx, codeRanges)) return idx;
    idx = text.indexOf(ACTION_OPEN, idx + ACTION_OPEN.length);
  }
  return -1;
}

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
 * Primary scanner for `<discord-action>` blocks.
 * Handles well-formed blocks and malformed variants where the closing tag is
 * wrong/missing (e.g. `</parameter>\n</invoke>`), using brace counting for the
 * JSON payload and then consuming trailing XML-like tags.
 */
function collectParsedAction(
  parsed: unknown,
  flags: ActionCategoryFlags,
  validTypes: Set<string>,
  actions: DiscordActionRequest[],
  strippedUnrecognizedTypes: string[],
): void {
  if (!parsed || typeof parsed !== 'object') return;
  const rewritten = rewriteLegacyPlanCloseToTaskClose(parsed as { type?: unknown; planId?: unknown }, flags);
  if (rewritten) {
    actions.push(rewritten);
    return;
  }
  if (typeof (parsed as { type?: unknown }).type !== 'string') return;
  const type = (parsed as { type: string }).type;
  if (validTypes.has(type)) {
    actions.push(parsed as DiscordActionRequest);
  } else {
    strippedUnrecognizedTypes.push(type);
  }
}

function parseActionJson(
  jsonStr: string,
  flags: ActionCategoryFlags,
  validTypes: Set<string>,
  actions: DiscordActionRequest[],
  strippedUnrecognizedTypes: string[],
  parseFailuresRef: { count: number },
): void {
  try {
    const parsed = JSON.parse(jsonStr);
    collectParsedAction(parsed, flags, validTypes, actions, strippedUnrecognizedTypes);
  } catch {
    parseFailuresRef.count++;
    // Malformed JSON — skip silently.
  }
}

function stripActionsWithScanner(
  text: string,
  flags: ActionCategoryFlags,
  validTypes: Set<string>,
  actions: DiscordActionRequest[],
  strippedUnrecognizedTypes: string[],
  codeRanges: TextRange[],
  parseFailuresRef: { count: number },
): string {
  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const idx = findNextActionOpenOutsideCode(text, cursor, codeRanges);
    if (idx === -1) { result += text.slice(cursor); break; }

    // Copy text before the marker.
    result += text.slice(cursor, idx);

    // Find the opening brace after the marker.
    let afterMarker = idx + ACTION_OPEN.length;
    // Skip whitespace between marker and brace.
    while (afterMarker < text.length && /\s/.test(text[afterMarker])) afterMarker++;

    if (afterMarker >= text.length || text[afterMarker] !== '{') {
      // No JSON object follows — keep the marker text as-is and move on.
      result += ACTION_OPEN;
      cursor = idx + ACTION_OPEN.length;
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

    parseActionJson(jsonStr, flags, validTypes, actions, strippedUnrecognizedTypes, parseFailuresRef);

    // Advance past the JSON object and consume any trailing XML closing tags.
    cursor = afterMarker + jsonStr.length;
    const remaining = text.slice(cursor);
    if (remaining.startsWith(ACTION_CLOSE)) {
      cursor += ACTION_CLOSE.length;
      continue;
    }
    const trailing = remaining.match(TRAILING_XML_RE);
    if (trailing) cursor += trailing[0].length;
  }

  return result;
}

function parseWithRegexFallback(
  text: string,
  flags: ActionCategoryFlags,
  validTypes: Set<string>,
  codeRanges: TextRange[],
): { cleanText: string; actions: DiscordActionRequest[]; strippedUnrecognizedTypes: string[]; parseFailures: number } {
  const actions: DiscordActionRequest[] = [];
  const strippedUnrecognizedTypes: string[] = [];
  const parseFailuresRef = { count: 0 };
  const cleaned = text.replace(ACTION_RE, (match, json: string, offset: number) => {
    if (isIndexInRanges(offset, codeRanges)) return match;
    parseActionJson(json.trim(), flags, validTypes, actions, strippedUnrecognizedTypes, parseFailuresRef);
    return '';
  });
  return {
    cleanText: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    actions,
    strippedUnrecognizedTypes,
    parseFailures: parseFailuresRef.count,
  };
}

export function parseDiscordActions(
  text: string,
  flags: ActionCategoryFlags,
): { cleanText: string; actions: DiscordActionRequest[]; strippedUnrecognizedTypes: string[]; parseFailures: number } {
  const validTypes = buildValidTypes(flags);
  const actions: DiscordActionRequest[] = [];
  const strippedUnrecognizedTypes: string[] = [];
  const codeRanges = computeMarkdownCodeRanges(text);
  const parseFailuresRef = { count: 0 };

  const cleaned = stripActionsWithScanner(text, flags, validTypes, actions, strippedUnrecognizedTypes, codeRanges, parseFailuresRef);
  const scanned = {
    cleanText: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    actions,
    strippedUnrecognizedTypes,
    parseFailures: parseFailuresRef.count,
  };

  // Compatibility fallback: if scanner leaves markers behind or extracts nothing,
  // run the legacy regex parser and prefer it when it captures more actions.
  const hasActionOutsideCode = findNextActionOpenOutsideCode(text, 0, codeRanges) !== -1;
  if (hasActionOutsideCode) {
    const markerLeft = scanned.cleanText.includes(ACTION_OPEN) || scanned.cleanText.includes(ACTION_CLOSE);
    if (markerLeft || scanned.actions.length === 0) {
      const legacy = parseWithRegexFallback(text, flags, validTypes, codeRanges);
      if (legacy.actions.length > scanned.actions.length) return legacy;
      if (markerLeft && legacy.actions.length === scanned.actions.length && legacy.cleanText.length < scanned.cleanText.length) {
        return legacy;
      }
    }
  }

  return scanned;
}

// ---------------------------------------------------------------------------
// Executor (dispatcher)
// ---------------------------------------------------------------------------

export async function executeDiscordActions(
  actions: DiscordActionRequest[],
  ctx: ActionContext,
  log?: LoggerLike,
  subs?: SubsystemContexts,
): Promise<DiscordActionResult[]> {
  const effectiveSubs = subs ?? {};

  const results: DiscordActionResult[] = [];

  for (const action of actions) {
    try {
      let result: DiscordActionResult;

      const destructiveCheck = describeDestructiveConfirmationRequirement(action as unknown as { type: string }, ctx.confirmation);
      if (!destructiveCheck.allow) {
        result = { ok: false, error: destructiveCheck.error };
        results.push(result);
        continue;
      }

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
      } else if (isTaskActionRequest(action)) {
        const taskCtx = effectiveSubs.taskCtx;
        if (!taskCtx) {
          result = { ok: false, error: 'Tasks subsystem not configured' };
        } else {
          result = await executeTaskAction(action, ctx, taskCtx);
        }
      } else if (CRON_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.cronCtx) {
          result = { ok: false, error: 'Cron subsystem not configured' };
        } else {
          result = await executeCronAction(action as CronActionRequest, ctx, effectiveSubs.cronCtx);
        }
      } else if (BOT_PROFILE_ACTION_TYPES.has(action.type)) {
        result = await executeBotProfileAction(action as BotProfileActionRequest, ctx);
      } else if (FORGE_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.forgeCtx) {
          result = { ok: false, error: 'Forge subsystem not configured' };
        } else {
          result = await executeForgeAction(action as ForgeActionRequest, ctx, effectiveSubs.forgeCtx);
        }
      } else if (PLAN_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.planCtx) {
          result = { ok: false, error: 'Plan subsystem not configured' };
        } else {
          result = await executePlanAction(action as PlanActionRequest, ctx, effectiveSubs.planCtx);
        }
      } else if (MEMORY_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.memoryCtx) {
          result = { ok: false, error: 'Memory subsystem not configured' };
        } else {
          result = await executeMemoryAction(action as MemoryActionRequest, ctx, effectiveSubs.memoryCtx);
        }
      } else if (DEFER_ACTION_TYPES.has(action.type)) {
        result = await executeDeferAction(action as DeferActionRequest, ctx);
      } else if (CONFIG_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.configCtx) {
          result = { ok: false, error: 'Config subsystem not configured' };
        } else {
          result = executeConfigAction(action as ConfigActionRequest, effectiveSubs.configCtx);
        }
      } else if (IMAGEGEN_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.imagegenCtx) {
          result = { ok: false, error: 'Imagegen subsystem not configured' };
        } else {
          result = await executeImagegenAction(action as ImagegenActionRequest, ctx, effectiveSubs.imagegenCtx);
        }
      } else {
        result = { ok: false, error: `Unknown action type: ${String(action.type ?? 'unknown')}` };
      }

      results.push(result);
      if (result.ok) {
        log?.info({ action: action.type, summary: result.summary }, `discord:action ${action.type}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, error: `Failed (${action.type}): ${msg}` });
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
      if (r.ok && (actions[i]?.type === 'sendMessage' || actions[i]?.type === 'sendFile')) return null;
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

  if (flags.tasks) {
    sections.push(taskActionsPromptSection());
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

  if (flags.imagegen) {
    sections.push(imagegenActionsPromptSection());
  }

  sections.push(`### Rules
- Only the action types listed above are supported.
- Never emit an action with empty, placeholder, or missing values for required parameters. If you don't have the value (e.g., no messageId for react), skip the action entirely.
- Confirm with the user before performing destructive actions (delete, kick, ban, timeout).
- Action blocks are removed from the displayed message; results are appended automatically.
- Results from information-gathering actions (channelList, channelInfo, threadListArchived, forumTagList, readMessages, fetchMessage, listPins, memberInfo, roleInfo, searchMessages, eventList, taskList, taskShow, cronList, cronShow, planList, planShow, memoryShow, modelShow) are automatically sent back to you for further analysis. You can emit a query action and continue reasoning in the follow-up.
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
