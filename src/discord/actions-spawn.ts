import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildMember } from 'discord.js';
import type { DiscordActionResult, ActionContext, ActionCategoryFlags, RequesterMemberContext, SubsystemContexts } from './actions.js';
import { parseDiscordActions, executeDiscordActions, appendActionResults } from './actions.js';
import { appendUnavailableActionTypesNotice, appendParseFailureNotice } from './output-common.js';
import { DiscordTransportClient } from './transport-client.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { DiscordChannelContext } from './channel-context.js';
import type { DeferScheduler } from './defer-scheduler.js';
import type { DeferActionRequest } from './actions-defer.js';
import type { ConcurrencyLimiter } from '../runtime/concurrency-limit.js';
import { resolveChannel, findChannelRaw, describeChannelType } from './action-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { splitDiscord } from './output-utils.js';
import { registerAbort } from './abort-registry.js';
import { registerSpawn } from './spawn-registry.js';
import {
  buildContextFiles,
  buildPromptPreamble,
  inlineContextFiles,
  loadWorkspacePaFiles,
  resolveEffectiveTools,
} from './prompt-common.js';

// ---------------------------------------------------------------------------
// Module-level counter for unique abort keys (avoids Date.now() collisions in parallel batches)
// ---------------------------------------------------------------------------

let spawnCounter = 0;
const REQUESTER_DENY_ALL = { __requesterDenyAll: true } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpawnActionRequest =
  | { type: 'spawnAgent'; channel: string; prompt: string; model?: string; label?: string };

const SPAWN_TYPE_MAP: Record<SpawnActionRequest['type'], true> = {
  spawnAgent: true,
};
export const SPAWN_ACTION_TYPES = new Set<string>(Object.keys(SPAWN_TYPE_MAP));

export type SpawnContext = {
  runtime: RuntimeAdapter;
  model: string;
  runtimeTools: string[];
  workspaceCwd: string;
  discordChannelContext?: DiscordChannelContext;
  useGroupDirCwd: boolean;
  appendSystemPrompt?: string;
  log?: LoggerLike;
  /** Recursion depth — 0 for user/cron origins, 1+ for action-triggered sub-invocations. */
  depth?: number;
  /** Max concurrent agents (default: 4). */
  maxConcurrent?: number;
  /** Timeout per agent invocation in ms (default: 120_000). */
  timeoutMs?: number;
  /** When set, parse and execute discord actions from the spawned agent's output. */
  actionFlags?: ActionCategoryFlags;
  /** Subsystem contexts forwarded to executeDiscordActions. */
  subsystems?: SubsystemContexts;
  /** Defer scheduler forwarded to the action context. */
  deferScheduler?: DeferScheduler<DeferActionRequest, ActionContext>;
  /** Global concurrency limiter — when set, each spawn acquires a permit before invoking the runtime. */
  limiter?: ConcurrencyLimiter;
};

function isRequesterDenyAll(
  requesterMember: RequesterMemberContext,
): requesterMember is typeof REQUESTER_DENY_ALL {
  return Boolean(requesterMember && typeof requesterMember === 'object' && '__requesterDenyAll' in requesterMember);
}

async function resolveRequesterMember(ctx: ActionContext): Promise<RequesterMemberContext> {
  if (!ctx.requesterId) return REQUESTER_DENY_ALL;
  const fetchRequester = (ctx.guild.members as { fetch?: (userId: string) => Promise<GuildMember> })?.fetch;
  if (typeof fetchRequester !== 'function') return REQUESTER_DENY_ALL;
  return fetchRequester.call(ctx.guild.members, ctx.requesterId).catch(() => REQUESTER_DENY_ALL);
}

function threadSendPermissionFor(channelType: ChannelType | undefined): bigint {
  return (
    channelType === ChannelType.PublicThread
    || channelType === ChannelType.PrivateThread
    || channelType === ChannelType.AnnouncementThread
  )
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

function requesterCanAccessTargetChannel(
  channel: unknown,
  requesterMember: Exclude<RequesterMemberContext, typeof REQUESTER_DENY_ALL | undefined>,
): boolean {
  if (!channel || typeof channel !== 'object') return false;
  if (!('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function') return false;
  const resolved = channel.permissionsFor(requesterMember);
  const channelType = 'type' in channel ? channel.type as ChannelType | undefined : undefined;
  return Boolean(
    resolved?.has?.(PermissionFlagsBits.ViewChannel | threadSendPermissionFor(channelType)),
  );
}

// ---------------------------------------------------------------------------
// Single executor
// ---------------------------------------------------------------------------

export async function executeSpawnAction(
  action: SpawnActionRequest,
  ctx: ActionContext,
  spawnCtx: SpawnContext,
): Promise<DiscordActionResult> {
  if ((spawnCtx.depth ?? 0) >= 1) {
    return { ok: false, error: 'spawnAgent blocked: recursion depth >= 1 (spawned agents cannot spawn further agents)' };
  }

  switch (action.type) {
    case 'spawnAgent': {
      if (!action.channel?.trim()) {
        return { ok: false, error: 'spawnAgent requires a non-empty channel' };
      }

      if (!action.prompt?.trim()) {
        return { ok: false, error: 'spawnAgent requires a non-empty prompt' };
      }

      // Resolve the target channel before the expensive runtime call.
      const targetChannel = resolveChannel(ctx.guild, action.channel);
      if (!targetChannel) {
        const raw = findChannelRaw(ctx.guild, action.channel);
        if (raw) {
          const kind = describeChannelType(raw);
          return { ok: false, error: `spawnAgent: "${action.channel}" is a ${kind} channel (use a text channel)` };
        }
        return { ok: false, error: `spawnAgent: channel "${action.channel}" not found` };
      }
      const requesterMember = await resolveRequesterMember(ctx);
      if (
        isRequesterDenyAll(requesterMember)
        || (requesterMember && !requesterCanAccessTargetChannel(targetChannel, requesterMember))
      ) {
        return { ok: false, error: 'Permission denied for spawnAgent' };
      }

      const label = action.label?.trim() || 'agent';
      const timeoutMs = spawnCtx.timeoutMs ?? 120_000;
      const model = action.model ?? spawnCtx.model;

      // --- Resolve effective tools ---
      let effectiveTools: string[] = spawnCtx.runtimeTools;
      try {
        const toolsInfo = await resolveEffectiveTools({
          workspaceCwd: spawnCtx.workspaceCwd,
          runtimeTools: spawnCtx.runtimeTools,
          runtimeCapabilities: spawnCtx.runtime.capabilities,
          runtimeId: spawnCtx.runtime.id,
          log: spawnCtx.log,
        });
        effectiveTools = toolsInfo.effectiveTools;
      } catch (err) {
        spawnCtx.log?.warn({ flow: 'spawn', label, err }, 'spawn:resolve effective tools failed');
      }

      // --- Build addDirs ---
      const addDirs: string[] = [];
      if (spawnCtx.useGroupDirCwd) addDirs.push(spawnCtx.workspaceCwd);
      if (spawnCtx.discordChannelContext) addDirs.push(spawnCtx.discordChannelContext.contentDir);
      const uniqueAddDirs = addDirs.length > 0 ? Array.from(new Set(addDirs)) : undefined;

      // --- Build prompt preamble with inlined PA context ---
      let preamble = '';
      try {
        const paFiles = await loadWorkspacePaFiles(spawnCtx.workspaceCwd, { skip: !!spawnCtx.appendSystemPrompt });
        const contextFiles = buildContextFiles(paFiles, spawnCtx.discordChannelContext, undefined);
        let inlinedContext = '';
        if (contextFiles.length > 0) {
          inlinedContext = await inlineContextFiles(contextFiles, {
            required: new Set(spawnCtx.discordChannelContext?.paContextFiles ?? []),
          });
        }
        preamble = buildPromptPreamble(inlinedContext);
      } catch (err) {
        spawnCtx.log?.warn({ flow: 'spawn', label, err }, 'spawn:preamble construction failed');
        preamble = buildPromptPreamble('');
      }

      const fullPrompt = preamble + '\n\n' + action.prompt;

      // Register in the abort registry so tryAbortAll() (via !stop) can kill this agent.
      const abortKey = `spawn-${++spawnCounter}-${label}`;
      const { signal, dispose: abortDispose } = registerAbort(abortKey);
      const { dispose: spawnDispose } = registerSpawn(abortKey, label);
      let releaseLimiter: (() => void) | undefined;
      try {
        if (spawnCtx.limiter) {
          releaseLimiter = await spawnCtx.limiter.acquire();
        }
        // If the signal was aborted while waiting for the limiter, skip the runtime call.
        if (signal.aborted) {
          return { ok: true, summary: `Agent (${label}) aborted` };
        }
        let text = '';
        const stream = spawnCtx.runtime.invoke({
          prompt: fullPrompt,
          model,
          cwd: spawnCtx.workspaceCwd,
          tools: effectiveTools,
          addDirs: uniqueAddDirs,
          timeoutMs,
          signal,
        });

        for await (const event of stream) {
          if (event.type === 'text_delta') {
            text += event.text;
          } else if (event.type === 'text_final') {
            text = event.text;
          } else if (event.type === 'error') {
            return { ok: false, error: `spawnAgent (${label}) failed: ${event.message}` };
          }
        }

        // --- Action parsing (when actionFlags provided) ---
        if (spawnCtx.actionFlags) {
          const parsed = parseDiscordActions(text, spawnCtx.actionFlags);
          const actCtx: ActionContext = {
            guild: ctx.guild,
            client: ctx.client,
            channelId: targetChannel.id,
            messageId: `spawn-${Date.now()}`,
            requesterId: ctx.requesterId,
            deferScheduler: spawnCtx.deferScheduler,
            transport: new DiscordTransportClient(ctx.guild, ctx.client),
            confirmation: { mode: 'automated' },
          };

          let actionResults: DiscordActionResult[] = [];
          if (parsed.actions.length > 0) {
            actionResults = await executeDiscordActions(parsed.actions, actCtx, spawnCtx.log, spawnCtx.subsystems);
          }

          let outgoingText = appendActionResults(parsed.cleanText.trim(), parsed.actions, actionResults);
          outgoingText = appendUnavailableActionTypesNotice(outgoingText, parsed.strippedUnrecognizedTypes).trim();
          outgoingText = appendParseFailureNotice(outgoingText, parsed.parseFailures).trim();
          const finalOutput = outgoingText || `Agent (${label}) completed with no output.`;

          const chunks = splitDiscord(finalOutput);
          for (const chunk of chunks) {
            await targetChannel.send({ content: chunk, allowedMentions: NO_MENTIONS });
          }

          return {
            ok: true,
            summary: `Agent (${label}) posted to #${targetChannel.name}`,
          };
        }

        // --- No action flags: raw text post (backward compatible) ---
        const outputText = text.trim() || `Agent (${label}) completed with no output.`;
        const chunks = splitDiscord(outputText);
        for (const chunk of chunks) {
          await targetChannel.send({ content: chunk, allowedMentions: NO_MENTIONS });
        }

        return {
          ok: true,
          summary: `Agent (${label}) posted to #${targetChannel.name}`,
        };
      } catch (err) {
        if (signal.aborted) {
          return { ok: true, summary: `Agent (${label}) aborted` };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `spawnAgent (${label}) failed: ${msg}` };
      } finally {
        releaseLimiter?.();
        spawnDispose();
        abortDispose();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parallel coordinator
// ---------------------------------------------------------------------------

/**
 * Execute multiple spawnAgent actions in parallel.
 * When a limiter is set on spawnCtx, it enforces the concurrency cap globally
 * (across all callers). Without a limiter, all actions fire concurrently.
 * Results are returned in the same order as the input actions.
 */
export async function executeSpawnActions(
  actions: SpawnActionRequest[],
  ctx: ActionContext,
  spawnCtx: SpawnContext,
): Promise<DiscordActionResult[]> {
  if (actions.length === 0) return [];

  const settled = await Promise.allSettled(
    actions.map((action) => executeSpawnAction(action, ctx, spawnCtx)),
  );

  return settled.map((item, i) => {
    if (item.status === 'fulfilled') return item.value;
    return {
      ok: false as const,
      error: item.reason instanceof Error ? item.reason.message : String(item.reason),
    };
  });
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function spawnActionsPromptSection(): string {
  return `### Spawn Agent

**spawnAgent** — Spawn a parallel sub-agent in a target channel:
\`\`\`
<discord-action>{"type":"spawnAgent","channel":"general","prompt":"List all open tasks and summarize their status","label":"task-summary"}</discord-action>
\`\`\`
- \`channel\` (required): Target channel name or ID where the spawned agent posts its output.
- \`prompt\` (required): The instruction to send to the sub-agent.
- \`model\` (optional): Model override for the spawned invocation.
- \`label\` (optional): A short human-readable label for the agent (used in error messages).

#### Spawn Guidelines
- Multiple spawnAgent actions in a single response are run in parallel for efficiency.
- Spawned agents run at recursion depth 1 and cannot themselves spawn further agents.
- The spawned agent runs fire-and-forget: it posts its output directly to the target channel.
- Keep prompts focused — each agent handles a single well-defined task.
- **Context isolation:** The spawned agent has **no conversation history** — it receives only the \`prompt\` string. The prompt must be fully self-contained: include all entity IDs, channel names, file paths, and relevant state. Do not reference "the above," "this task," or anything from the current conversation — the spawned agent cannot see it.`;
}
