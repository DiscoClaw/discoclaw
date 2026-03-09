import type { Client, Guild, GuildMember } from 'discord.js';
import type { TransportClient } from './transport-client.js';
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
import { DEFER_ACTION_TYPES, executeDeferAction, executeDeferListAction } from './actions-defer.js';
import type { DeferActionRequest, DeferListActionRequest, DeferActionRequestUnion } from './actions-defer.js';
import type { DeferScheduler } from './defer-scheduler.js';
import { CONFIG_ACTION_TYPES, executeConfigAction, configActionsPromptSection } from './actions-config.js';
import type { ConfigActionRequest, ConfigContext } from './actions-config.js';
import { executeReactionPromptAction as executeReactionPrompt, REACTION_PROMPT_ACTION_TYPES, reactionPromptSection } from './reaction-prompts.js';
import type { ReactionPromptRequest } from './reaction-prompts.js';
import { IMAGEGEN_ACTION_TYPES, executeImagegenAction, imagegenActionsPromptSection } from './actions-imagegen.js';
import type { ImagegenActionRequest, ImagegenContext } from './actions-imagegen.js';
import { VOICE_ACTION_TYPES, executeVoiceAction, voiceActionsPromptSection } from './actions-voice.js';
import type { VoiceActionRequest, VoiceContext } from './actions-voice.js';
import { SPAWN_ACTION_TYPES, executeSpawnActions, spawnActionsPromptSection } from './actions-spawn.js';
import type { SpawnActionRequest, SpawnContext } from './actions-spawn.js';
import { describeDestructiveConfirmationRequirement } from './destructive-confirmation.js';
import { computeMarkdownCodeRanges } from './markdown-code-ranges.js';
import { parseCapsuleBlock } from './capsule.js';
import type { ContinuationCapsule } from './capsule.js';
export { computeMarkdownCodeRanges } from './markdown-code-ranges.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionContext = {
  guild: Guild;
  client: Client;
  channelId: string;
  messageId: string;
  requesterId?: string;
  threadParentId?: string | null;
  deferScheduler?: DeferScheduler<DeferActionRequest, ActionContext>;
  deferDepth?: number;
  transport?: TransportClient;
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
  loop?: boolean;
  imagegen?: boolean;
  voice?: boolean;
  spawn?: boolean;
};

export type LoopActionRequest =
  | { type: 'loopCreate'; [key: string]: unknown }
  | { type: 'loopList'; [key: string]: unknown }
  | { type: 'loopCancel'; [key: string]: unknown };

const LOOP_ACTION_TYPES = new Set<string>(['loopCreate', 'loopList', 'loopCancel']);

async function executeLoopAction(
  _action: LoopActionRequest,
  _ctx: ActionContext,
): Promise<DiscordActionResult> {
  return { ok: false, error: 'Loop actions are not configured for this bot' };
}

function loopActionsPromptSection(): string {
  return `### Repeating loops
Use <discord-action>{"type":"loopCreate","channel":"general","intervalSeconds":900,"prompt":"Check the forge status for forge-123 and report changes","label":"forge-watch"}</discord-action> to schedule a repeating self-invocation. Loops are inspectable repeating jobs with metadata such as interval, next run time, origin channel/thread, and an optional purpose label.

Use <discord-action>{"type":"loopList"}</discord-action> to inspect active loops and <discord-action>{"type":"loopCancel","id":123}</discord-action> to stop one. As with defer, the prompt must be fully self-contained because each loop tick runs without conversation history.`;
}

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
  | DeferListActionRequest
  | LoopActionRequest
  | ConfigActionRequest
  | ReactionPromptRequest
  | ImagegenActionRequest
  | VoiceActionRequest
  | SpawnActionRequest;

export type DiscordActionResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

export type RequesterDenyAll = { readonly __requesterDenyAll: true };
export type RequesterMemberContext = GuildMember | RequesterDenyAll | undefined;

export const REQUESTER_MEMBER_DENY_ALL: RequesterDenyAll = { __requesterDenyAll: true };

export function withoutRequesterGatedActionFlags(flags: ActionCategoryFlags): ActionCategoryFlags {
  return {
    ...flags,
    channels: false,
    messaging: false,
    guild: false,
    moderation: false,
    polls: false,
  };
}

import { appendOutsideFence } from './output-utils.js';
import type { LoggerLike } from '../logging/logger-like.js';

export type SubsystemContexts = {
  taskCtx?: TaskContext;
  cronCtx?: CronContext;
  forgeCtx?: ForgeContext;
  planCtx?: PlanContext;
  memoryCtx?: MemoryContext;
  configCtx?: ConfigContext;
  imagegenCtx?: ImagegenContext;
  voiceCtx?: VoiceContext;
  spawnCtx?: SpawnContext;
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
  if (flags.loop) for (const t of LOOP_ACTION_TYPES) types.add(t);
  if (flags.config) for (const t of CONFIG_ACTION_TYPES) types.add(t);
  if (flags.imagegen) for (const t of IMAGEGEN_ACTION_TYPES) types.add(t);
  if (flags.voice) for (const t of VOICE_ACTION_TYPES) types.add(t);
  if (flags.spawn) for (const t of SPAWN_ACTION_TYPES) types.add(t);
  return types;
}

function buildAllowedTypes(
  flags: ActionCategoryFlags,
  allowedActionTypes?: Iterable<string>,
): Set<string> {
  const validTypes = buildValidTypes(flags);
  if (!allowedActionTypes) return validTypes;

  const allowedSet = new Set(allowedActionTypes);
  return new Set([...validTypes].filter((type) => allowedSet.has(type)));
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

type TextRange = ReturnType<typeof computeMarkdownCodeRanges>[number];

function isIndexInRanges(index: number, ranges: TextRange[]): boolean {
  for (const range of ranges) {
    if (index < range.start) return false;
    if (index < range.end) return true;
  }
  return false;
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
): ParsedDiscordActionsResult {
  const actions: DiscordActionRequest[] = [];
  const strippedUnrecognizedTypes: string[] = [];
  const parseFailuresRef = { count: 0 };
  const cleaned = text.replace(ACTION_RE, (match, json: string, offset: number) => {
    if (isIndexInRanges(offset, codeRanges)) return match;
    parseActionJson(json.trim(), flags, validTypes, actions, strippedUnrecognizedTypes, parseFailuresRef);
    return '';
  });
  const parsedCapsule = parseCapsuleBlock(cleaned.replace(/\n{3,}/g, '\n\n').trim());
  return {
    cleanText: parsedCapsule.cleanText,
    actions,
    strippedUnrecognizedTypes,
    parseFailures: parseFailuresRef.count,
    continuationCapsule: parsedCapsule.capsule,
  };
}

export type ParsedDiscordActionsResult = {
  cleanText: string;
  actions: DiscordActionRequest[];
  strippedUnrecognizedTypes: string[];
  parseFailures: number;
  continuationCapsule?: ContinuationCapsule | null;
};

export function parseDiscordActions(
  text: string,
  flags: ActionCategoryFlags,
  allowedActionTypes?: Iterable<string>,
): ParsedDiscordActionsResult {
  const validTypes = buildAllowedTypes(flags, allowedActionTypes);
  const actions: DiscordActionRequest[] = [];
  const strippedUnrecognizedTypes: string[] = [];
  const codeRanges = computeMarkdownCodeRanges(text);
  const parseFailuresRef = { count: 0 };

  const cleaned = stripActionsWithScanner(text, flags, validTypes, actions, strippedUnrecognizedTypes, codeRanges, parseFailuresRef);
  const parsedCapsule = parseCapsuleBlock(cleaned.replace(/\n{3,}/g, '\n\n').trim());
  const scanned: ParsedDiscordActionsResult = {
    cleanText: parsedCapsule.cleanText,
    actions,
    strippedUnrecognizedTypes,
    parseFailures: parseFailuresRef.count,
    continuationCapsule: parsedCapsule.capsule,
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
  let requesterMember: RequesterMemberContext = REQUESTER_MEMBER_DENY_ALL;
  if (ctx.requesterId) {
    const fetchRequester = (ctx.guild.members as { fetch?: (userId: string) => Promise<GuildMember> })?.fetch;
    requesterMember = typeof fetchRequester === 'function'
      ? await fetchRequester.call(ctx.guild.members, ctx.requesterId).catch(() => REQUESTER_MEMBER_DENY_ALL)
      : REQUESTER_MEMBER_DENY_ALL;
  }

  // --- Spawn pre-pass: collect all spawnAgent actions and run in parallel ---
  const spawnResultByIndex = new Map<number, DiscordActionResult>();
  if (effectiveSubs.spawnCtx) {
    const spawnActions: SpawnActionRequest[] = [];
    const spawnIndices: number[] = [];
    for (let i = 0; i < actions.length; i++) {
      if (SPAWN_ACTION_TYPES.has(actions[i]!.type)) {
        spawnActions.push(actions[i]! as SpawnActionRequest);
        spawnIndices.push(i);
      }
    }
    if (spawnActions.length > 0) {
      const spawnResults = await executeSpawnActions(spawnActions, ctx, effectiveSubs.spawnCtx);
      for (let i = 0; i < spawnIndices.length; i++) {
        spawnResultByIndex.set(spawnIndices[i]!, spawnResults[i]!);
      }
    }
  }

  const results: DiscordActionResult[] = [];

  for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
    const action = actions[actionIdx]!;
    try {
      // Spawn actions were executed in parallel in the pre-pass above.
      if (spawnResultByIndex.has(actionIdx)) {
        const result = spawnResultByIndex.get(actionIdx)!;
        results.push(result);
        if (result.ok) {
          log?.info({ action: action.type, summary: result.summary }, `discord:action ${action.type}`);
        }
        continue;
      }

      let result: DiscordActionResult;

      const destructiveCheck = describeDestructiveConfirmationRequirement(action as unknown as { type: string }, ctx.confirmation);
      if (!destructiveCheck.allow) {
        result = { ok: false, error: destructiveCheck.error };
        results.push(result);
        continue;
      }

      if (CHANNEL_ACTION_TYPES.has(action.type)) {
        result = await executeChannelAction(action as ChannelActionRequest, ctx, requesterMember);
      } else if (MESSAGING_ACTION_TYPES.has(action.type)) {
        result = await executeMessagingAction(action as MessagingActionRequest, ctx, requesterMember);
      } else if (REACTION_PROMPT_ACTION_TYPES.has(action.type)) {
        result = await executeReactionPrompt(action as ReactionPromptRequest, ctx);
      } else if (GUILD_ACTION_TYPES.has(action.type)) {
        result = await executeGuildAction(action as GuildActionRequest, ctx, requesterMember);
      } else if (MODERATION_ACTION_TYPES.has(action.type)) {
        result = await executeModerationAction(action as ModerationActionRequest, ctx, requesterMember);
      } else if (POLL_ACTION_TYPES.has(action.type)) {
        result = await executePollAction(action as PollActionRequest, ctx, requesterMember);
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
        if (action.type === 'deferList') {
          result = executeDeferListAction(ctx);
        } else {
          result = await executeDeferAction(action as DeferActionRequest, ctx);
        }
      } else if (LOOP_ACTION_TYPES.has(action.type)) {
        result = await executeLoopAction(action as LoopActionRequest, ctx);
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
      } else if (VOICE_ACTION_TYPES.has(action.type)) {
        if (!effectiveSubs.voiceCtx) {
          result = { ok: false, error: 'Voice subsystem not configured' };
        } else {
          result = await executeVoiceAction(action as VoiceActionRequest, ctx, effectiveSubs.voiceCtx);
        }
      } else if (SPAWN_ACTION_TYPES.has(action.type)) {
        // spawnCtx not configured — would have been handled in pre-pass otherwise.
        result = { ok: false, error: 'Spawn subsystem not configured' };
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
      if (r.ok && (actions[i]?.type === 'sendMessage' || actions[i]?.type === 'sendFile' || actions[i]?.type === 'spawnAgent')) return null;
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

/**
 * Append display result lines to body text, automatically closing any
 * unclosed fenced code block so the results render outside the block.
 * Returns body unchanged when there are no display lines.
 */
export function appendActionResults(
  body: string,
  actions: { type: string }[],
  results: DiscordActionResult[],
): string {
  const displayLines = buildDisplayResultLines(actions, results);
  if (displayLines.length === 0) return body;
  return appendOutsideFence(body, displayLines.join('\n'));
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export type ActionSchemaTier = 'core' | 'channelContextual' | 'keywordTriggered';

export type ActionSchemaSelection = {
  prompt: string;
  includedCategories: string[];
  tierBuckets: Record<ActionSchemaTier, string[]>;
  keywordHits: string[];
};

type ActionSchemaCategory =
  | 'channels'
  | 'messaging'
  | 'guild'
  | 'moderation'
  | 'polls'
  | 'tasks'
  | 'crons'
  | 'botProfile'
  | 'forge'
  | 'plan'
  | 'memory'
  | 'defer'
  | 'loop'
  | 'config'
  | 'imagegen'
  | 'voice'
  | 'spawn';

const ACTION_SCHEMA_CATEGORY_ORDER: ActionSchemaCategory[] = [
  'messaging',
  'channels',
  'guild',
  'moderation',
  'polls',
  'tasks',
  'crons',
  'botProfile',
  'forge',
  'plan',
  'memory',
  'defer',
  'loop',
  'config',
  'imagegen',
  'voice',
  'spawn',
];

const ACTION_SCHEMA_CORE_CATEGORIES: ActionSchemaCategory[] = ['messaging', 'channels'];

const ACTION_SCHEMA_TASK_CONTEXT_RE = /\b(task|tasks|todo|ticket|issue|backlog|sprint)\b/i;
const ACTION_SCHEMA_CRON_CONTEXT_RE = /\b(cron|schedule|scheduled|reminder|remind|timer)\b/i;

type ActionSchemaKeywordRule = {
  hit: string;
  pattern: RegExp;
  categories: ActionSchemaCategory[];
};

const ACTION_SCHEMA_KEYWORD_RULES: ActionSchemaKeywordRule[] = [
  { hit: 'memory', pattern: /\b(memory|remember|forget|recall|preference)\b/i, categories: ['memory'] },
  { hit: 'task', pattern: /\b(task|todo|ticket|issue|backlog)\b/i, categories: ['tasks'] },
  { hit: 'plan', pattern: /\b(plan|roadmap|milestone|phase)\b/i, categories: ['plan', 'forge'] },
  { hit: 'forge', pattern: /\bforge\b/i, categories: ['forge', 'plan'] },
  { hit: 'cron', pattern: /\b(cron|schedule|scheduled|reminder|remind|later)\b/i, categories: ['crons', 'defer'] },
  { hit: 'loop', pattern: /\b(loop|repeat|repeating|interval)\b/i, categories: ['loop'] },
  { hit: 'config', pattern: /\b(model|config|configure|setting)\b/i, categories: ['config'] },
  { hit: 'imagegen', pattern: /\b(image|generate image|draw|illustration|photo)\b/i, categories: ['imagegen'] },
  { hit: 'voice', pattern: /\b(voice|speak|mute|unmute)\b/i, categories: ['voice'] },
  { hit: 'moderation', pattern: /\b(moderat|ban|kick|timeout)\b/i, categories: ['moderation'] },
  { hit: 'poll', pattern: /\b(poll|vote)\b/i, categories: ['polls'] },
  { hit: 'guild', pattern: /\b(guild|server|member|role|event)\b/i, categories: ['guild'] },
  { hit: 'botProfile', pattern: /\b(bot profile|bot name|persona)\b/i, categories: ['botProfile'] },
  { hit: 'spawn', pattern: /\b(spawn|agent)\b/i, categories: ['spawn'] },
];

function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function pushUnique<T extends string>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}

function isActionSchemaCategoryEnabled(flags: ActionCategoryFlags, category: ActionSchemaCategory): boolean {
  switch (category) {
    case 'channels': return flags.channels;
    case 'messaging': return flags.messaging;
    case 'guild': return flags.guild;
    case 'moderation': return flags.moderation;
    case 'polls': return flags.polls;
    case 'tasks': return flags.tasks;
    case 'crons': return flags.crons;
    case 'botProfile': return flags.botProfile;
    case 'forge': return flags.forge;
    case 'plan': return flags.plan;
    case 'memory': return flags.memory;
    case 'defer': return flags.defer;
    case 'loop': return Boolean(flags.loop);
    case 'config': return flags.config;
    case 'imagegen': return Boolean(flags.imagegen);
    case 'voice': return Boolean(flags.voice);
    case 'spawn': return Boolean(flags.spawn);
  }
}

function renderActionSchemaCategorySection(category: ActionSchemaCategory): string {
  switch (category) {
    case 'messaging':
      return `${messagingActionsPromptSection()}\n\n${reactionPromptSection()}`;
    case 'channels':
      return channelActionsPromptSection();
    case 'guild':
      return guildActionsPromptSection();
    case 'moderation':
      return moderationActionsPromptSection();
    case 'polls':
      return pollActionsPromptSection();
    case 'tasks':
      return taskActionsPromptSection();
    case 'crons':
      return cronActionsPromptSection();
    case 'botProfile':
      return botProfileActionsPromptSection();
    case 'forge':
      return forgeActionsPromptSection();
    case 'plan':
      return planActionsPromptSection();
    case 'memory':
      return memoryActionsPromptSection();
    case 'config':
      return configActionsPromptSection();
    case 'loop':
      return loopActionsPromptSection();
    case 'imagegen':
      return imagegenActionsPromptSection();
    case 'voice':
      return voiceActionsPromptSection();
    case 'spawn':
      return spawnActionsPromptSection();
    case 'defer':
      return '';
  }
}

function discordActionsIntroSection(): string {
  return `## Discord Actions
Perform Discord server actions by including \`<discord-action>\` JSON blocks in your response.`;
}

function discordActionsRulesSection(displayName: string): string {
  return `### Rules
- Only action types listed above are supported. Never emit actions with empty/placeholder/missing required parameters — skip instead.
- Confirm with the user before destructive actions (delete, kick, ban, timeout).
- Action blocks are stripped from displayed output; results appended automatically.
- Actions ending in List, Show, Info, Status, or prefixed with fetch/read/search are query actions — results are sent back for follow-up analysis.
- Include all needed actions in one response. Multiple same-type actions are supported and executed sequentially.
- Keep the continuation capsule current with a single \`<continuation-capsule>{"activeTaskId":"...","currentFocus":"...","nextStep":"...","blockedOn":"..."}</continuation-capsule>\` block whenever the active task, current focus, next step, or blocker changes.
- Keep continuation capsules machine-readable only; do not mention them in user-facing prose.

### Permissions
Bot requires appropriate server-level role permissions (e.g. Manage Channels, Manage Roles, Moderate Members).
If "Missing Permissions" errors occur, tell the user to check **Server Settings → Roles** and enable the required permission on the ${displayName} bot's role.`;
}

function deferredSelfInvocationSection(): string {
  return `### Deferred self-invocation
Use a <discord-action>{"type":"defer","channel":"general","delaySeconds":600,"prompt":"Check on the forge run"}</discord-action> block to schedule a follow-up run inside the requested channel without another user prompt. You must specify the channel by name or ID; delaySeconds is how long to wait (capped by DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS) and prompt becomes the user message when the deferred invocation runs. The scheduler enforces DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT pending jobs, respects the same channel permissions as this response, automatically posts the follow-up output, and allows nested defers up to the configured depth limit (DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DEPTH, default 4); once the limit is reached, \`defer\` is disabled for that run. If a guard rail rejects the request (too long, too many active defers, missing permissions, or the channel becomes invalid) the action fails with an explanatory message.

**Context isolation warning:** The deferred invocation runs with no conversation history — the \`prompt\` string is the **only** context the AI receives. It must include all relevant IDs, file paths, channel references, and state needed to act. Vague prompts like "check on that" will fail because the AI has no memory of what "that" refers to. Write every deferred prompt as a fully self-contained instruction.

Use <discord-action>{"type":"deferList"}</discord-action> to query all pending deferred actions. Returns a job \`id\`, channel, prompt, and time remaining for each entry. This is a read-only query action — results are automatically sent back for further analysis.`;
}

function deriveContextualCategories(opts: {
  channelName?: string;
  channelContextPath?: string | null;
  isThread?: boolean;
}): ActionSchemaCategory[] {
  const categories: ActionSchemaCategory[] = [];
  const contextText = `${opts.channelName ?? ''} ${opts.channelContextPath ?? ''}`.trim();
  if (opts.isThread || ACTION_SCHEMA_TASK_CONTEXT_RE.test(contextText)) {
    categories.push('tasks');
  }
  if (ACTION_SCHEMA_CRON_CONTEXT_RE.test(contextText)) {
    categories.push('crons');
  }
  return categories;
}

function deriveKeywordCategories(userText?: string): {
  categories: ActionSchemaCategory[];
  keywordHits: string[];
} {
  const categories: ActionSchemaCategory[] = [];
  const keywordHits: string[] = [];
  if (!userText?.trim()) return { categories, keywordHits };

  for (const rule of ACTION_SCHEMA_KEYWORD_RULES) {
    if (!rule.pattern.test(userText)) continue;
    pushUnique(keywordHits, rule.hit);
    for (const category of rule.categories) {
      pushUnique(categories, category);
    }
  }
  return { categories, keywordHits };
}

function maybeLogActionSchemaTokenEstimates(input: {
  selection: Omit<ActionSchemaSelection, 'prompt'>;
  sections: Array<{ section: string; content: string }>;
}): void {
  if (process.env.DISCOCLAW_LOG_ACTION_SCHEMA_ESTIMATES !== '1') return;
  const estimates = input.sections.map((section) => {
    const chars = section.content.length;
    return {
      section: section.section,
      chars,
      estTokens: estimateTokensFromChars(chars),
    };
  });
  const totalChars = estimates.reduce((sum, current) => sum + current.chars, 0);
  console.info(
    '[discord:actions:schema-estimates]',
    JSON.stringify({
      ...input.selection,
      sections: estimates,
      totalChars,
      totalEstTokens: estimateTokensFromChars(totalChars),
    }),
  );
}

export function buildTieredDiscordActionsPromptSection(
  flags: ActionCategoryFlags,
  botDisplayName?: string,
  opts?: {
    channelName?: string;
    channelContextPath?: string | null;
    isThread?: boolean;
    userText?: string;
  },
): ActionSchemaSelection {
  const displayName = botDisplayName ?? 'Discoclaw';
  const tierBuckets: Record<ActionSchemaTier, ActionSchemaCategory[]> = {
    core: [],
    channelContextual: [],
    keywordTriggered: [],
  };
  const included = new Set<ActionSchemaCategory>();
  const keywordHits: string[] = [];

  const addCategory = (tier: ActionSchemaTier, category: ActionSchemaCategory): void => {
    if (!isActionSchemaCategoryEnabled(flags, category)) return;
    if (included.has(category)) return;
    included.add(category);
    tierBuckets[tier].push(category);
  };

  if (!opts) {
    for (const category of ACTION_SCHEMA_CATEGORY_ORDER) {
      addCategory('core', category);
    }
  } else {
    for (const category of ACTION_SCHEMA_CORE_CATEGORIES) {
      addCategory('core', category);
    }

    for (const category of deriveContextualCategories(opts)) {
      addCategory('channelContextual', category);
    }

    const keywordSelection = deriveKeywordCategories(opts.userText);
    for (const hit of keywordSelection.keywordHits) {
      pushUnique(keywordHits, hit);
    }
    for (const category of keywordSelection.categories) {
      addCategory('keywordTriggered', category);
    }
  }

  const includedCategories = ACTION_SCHEMA_CATEGORY_ORDER.filter((category) => included.has(category));
  const sections: string[] = [];
  const sectionLogs: Array<{ section: string; content: string }> = [];
  const intro = discordActionsIntroSection();
  sections.push(intro);
  sectionLogs.push({ section: 'intro', content: intro });

  for (const category of includedCategories) {
    if (category === 'defer') continue;
    const section = renderActionSchemaCategorySection(category);
    if (!section) continue;
    sections.push(section);
    sectionLogs.push({ section: category, content: section });
  }

  const rules = discordActionsRulesSection(displayName);
  sections.push(rules);
  sectionLogs.push({ section: 'rules', content: rules });

  if (included.has('defer')) {
    const deferSection = deferredSelfInvocationSection();
    sections.push(deferSection);
    sectionLogs.push({ section: 'defer', content: deferSection });
  }

  const selection: ActionSchemaSelection = {
    prompt: sections.join('\n\n'),
    includedCategories,
    tierBuckets: {
      core: [...tierBuckets.core],
      channelContextual: [...tierBuckets.channelContextual],
      keywordTriggered: [...tierBuckets.keywordTriggered],
    },
    keywordHits,
  };

  maybeLogActionSchemaTokenEstimates({
    selection: {
      includedCategories: selection.includedCategories,
      tierBuckets: selection.tierBuckets,
      keywordHits: selection.keywordHits,
    },
    sections: sectionLogs,
  });

  return selection;
}

export function discordActionsPromptSection(flags: ActionCategoryFlags, botDisplayName?: string): string {
  return buildTieredDiscordActionsPromptSection(flags, botDisplayName).prompt;
}
