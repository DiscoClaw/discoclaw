import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { ForgeOrchestrator } from './forge-commands.js';
import { executePlanAction } from './actions-plan.js';
import type { PlanContext } from './actions-plan.js';
import type { TaskStore } from '../tasks/store.js';
import { looksLikePlanId, findPlanFile, listPlanFiles } from './plan-commands.js';
import type { HandlePlanCommandOpts } from './plan-commands.js';
import { buildPlanSummary } from './forge-commands.js';
import { createStreamingProgress } from './streaming-progress.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { taskThreadCache } from '../tasks/thread-cache.js';
import type { LongRunWatchdog } from './long-run-watchdog.js';
import {
  getActiveOrchestrator,
  getActiveForgeId,
  acquireWriterLock,
  setActiveOrchestrator,
  getRunningPlanIds,
} from './forge-plan-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForgeActionRequest =
  | { type: 'forgeCreate'; description: string; context?: string }
  | { type: 'forgeResume'; planId: string }
  | { type: 'forgeStatus' }
  | { type: 'forgeCancel' };

const FORGE_TYPE_MAP: Record<ForgeActionRequest['type'], true> = {
  forgeCreate: true,
  forgeResume: true,
  forgeStatus: true,
  forgeCancel: true,
};
export const FORGE_ACTION_TYPES = new Set<string>(Object.keys(FORGE_TYPE_MAP));

export type ForgeContext = {
  orchestratorFactory: (overrides?: {
    existingTaskId?: string;
    taskDescription?: string;
    pinnedThreadSummary?: string;
  }) => ForgeOrchestrator;
  plansDir: string;
  workspaceCwd: string;
  taskStore: TaskStore;
  /** Callback to send progress messages to the originating channel. */
  onProgress: (msg: string, opts?: { force?: boolean }) => Promise<void>;
  /** Static-progress throttle for streaming progress edits. */
  progressThrottleMs?: number;
  /** Whether runtime event-driven tool/text streaming is enabled. Defaults to true. */
  toolAwareStreaming?: boolean;
  log?: LoggerLike;
  /** Recursion depth — 0 for user/cron origins, 1+ for action-triggered sub-invocations. */
  depth?: number;
  /** Optional lifecycle watchdog for long-running forge runs. */
  longRunWatchdog?: Pick<LongRunWatchdog, 'start' | 'complete'>;
  /** Optional override for watchdog still-running check-in delay. */
  longRunStillRunningDelayMs?: number;
  /** Optional plan action context so approved plans can resume implementation via planRun. */
  planCtx?: PlanContext;
};

type SendFn = (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;

function resolveSendFn(channel: unknown): SendFn | null {
  if (!channel || typeof channel !== 'object') return null;
  const maybeSend = (channel as { send?: unknown }).send;
  if (typeof maybeSend !== 'function') return null;
  return maybeSend.bind(channel) as SendFn;
}

function errorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function isArchivedThreadError(err: unknown): boolean {
  return errorCode(err) === 50083;
}

function shouldRouteForgeResumeToPlanRun(status: string | undefined): boolean {
  return status === 'APPROVED' || status === 'IMPLEMENTING';
}

async function resolveLinkedTaskForThread(
  ctx: ActionContext,
  forgeCtx: ForgeContext,
): Promise<{ existingTaskId?: string; taskDescription?: string }> {
  if (!ctx.threadParentId) return {};
  try {
    const task = await taskThreadCache.get(ctx.channelId, forgeCtx.taskStore);
    if (!task) return {};
    return { existingTaskId: task.id, taskDescription: task.description };
  } catch (err) {
    forgeCtx.log?.warn({ err, channelId: ctx.channelId }, 'forge:action thread-task lookup failed');
    return {};
  }
}

async function buildProgressCallbacks(
  ctx: ActionContext,
  forgeCtx: ForgeContext,
  startMessage: string,
): Promise<{
  onProgress: (msg: string, opts?: { force?: boolean }) => Promise<void>;
  onEvent?: ReturnType<typeof createStreamingProgress>['onEvent'];
  sendPlanSummary: (summary?: string) => Promise<boolean>;
  dispose: () => void;
}> {
  const fallback = {
    onProgress: forgeCtx.onProgress,
    onEvent: undefined as ReturnType<typeof createStreamingProgress>['onEvent'] | undefined,
    sendPlanSummary: async (summary?: string) => {
      if (!summary) return true;
      try {
        await forgeCtx.onProgress(summary, { force: true });
        return true;
      } catch {
        return false;
      }
    },
    dispose: () => {},
  };

  try {
    const channel = await ctx.client.channels.fetch(ctx.channelId);
    const send = resolveSendFn(channel);
    if (!send) return fallback;

    const progressReply = await send({ content: startMessage, allowedMentions: NO_MENTIONS }) as {
      edit?: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;
    };
    if (!progressReply || typeof progressReply.edit !== 'function') return fallback;

    const controller = createStreamingProgress(
      progressReply as { edit: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown> },
      forgeCtx.progressThrottleMs ?? 3000,
      {
        throwOnFatal: true,
        onFatalError: (err) => {
          forgeCtx.log?.warn({ err, channelId: ctx.channelId }, 'forge:action progress thread archived');
        },
      },
    );
    const enableToolAwareStreaming = forgeCtx.toolAwareStreaming ?? true;
    return {
      onProgress: async (msg: string, opts?: { force?: boolean }) => {
        await controller.onProgress(msg, opts);
      },
      onEvent: enableToolAwareStreaming ? controller.onEvent : undefined,
      sendPlanSummary: async (summary?: string) => {
        if (!summary) return true;
        try {
          await send({ content: summary, allowedMentions: NO_MENTIONS });
          return true;
        } catch (err) {
          if (isArchivedThreadError(err)) {
            try {
              await forgeCtx.onProgress(summary, { force: true });
              return true;
            } catch {
              return false;
            }
          }
          return false;
        }
      },
      dispose: controller.dispose,
    };
  } catch (err) {
    forgeCtx.log?.warn({ err, channelId: ctx.channelId }, 'forge:action progress channel unavailable');
    return fallback;
  }
}

function buildForgeWatchdogId(kind: 'create' | 'resume', ctx: ActionContext, suffix: string): string {
  return `forge-action:${kind}:${ctx.channelId}:${ctx.messageId}:${suffix}`;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeForgeAction(
  action: ForgeActionRequest,
  ctx: ActionContext,
  forgeCtx: ForgeContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'forgeCreate': {
      if ((forgeCtx.depth ?? 0) >= 1) {
        return { ok: false, error: 'forgeCreate blocked: recursion depth >= 1 (forge cannot spawn another forge)' };
      }

      if (!action.description) {
        return { ok: false, error: 'forgeCreate requires a description' };
      }

      const existing = getActiveOrchestrator();
      if (existing?.isRunning) {
        const activeId = getActiveForgeId();
        return {
          ok: false,
          error: `A forge is already running${activeId ? ` (${activeId})` : ''}. Cancel it first with forgeCancel.`,
        };
      }

      const threadTask = await resolveLinkedTaskForThread(ctx, forgeCtx);
      const progress = await buildProgressCallbacks(ctx, forgeCtx, `🛠️ Starting forge: ${action.description}`);
      const orchestrator = forgeCtx.orchestratorFactory({
        existingTaskId: threadTask.existingTaskId,
        taskDescription: threadTask.taskDescription,
      });
      setActiveOrchestrator(orchestrator, [ctx.channelId, ctx.threadParentId]);
      const watchdog = forgeCtx.longRunWatchdog;
      const watchdogRunId = buildForgeWatchdogId('create', ctx, action.description.trim().slice(0, 64) || 'run');
      if (watchdog) {
        try {
          await watchdog.start({
            runId: watchdogRunId,
            channelId: ctx.channelId,
            messageId: ctx.messageId,
            stillRunningDelayMs: forgeCtx.longRunStillRunningDelayMs,
          });
        } catch (err) {
          forgeCtx.log?.warn({ err, runId: watchdogRunId }, 'forge:action:create watchdog start failed');
        }
      }

      // Fire and forget — forge runs asynchronously with progress callbacks.
      const release = await acquireWriterLock();
      void orchestrator
        .run(action.description, progress.onProgress, action.context, progress.onEvent)
        .then(async (result) => {
          let outcome: 'succeeded' | 'failed' = result.error ? 'failed' : 'succeeded';
          const postedSummary = await progress.sendPlanSummary(result.planSummary);
          if (!postedSummary) outcome = 'failed';
          if (watchdog) {
            try {
              await watchdog.complete(watchdogRunId, { outcome });
            } catch (err) {
              forgeCtx.log?.warn({ err, runId: watchdogRunId }, 'forge:action:create watchdog complete failed');
            }
          }
        })
        .catch(async (err) => {
          forgeCtx.log?.error({ err }, 'forge:action:create failed');
          if (watchdog) {
            try {
              await watchdog.complete(watchdogRunId, { outcome: 'failed' });
            } catch (completeErr) {
              forgeCtx.log?.warn({ err: completeErr, runId: watchdogRunId }, 'forge:action:create watchdog complete failed');
            }
          }
        })
        .finally(() => {
          progress.dispose();
          setActiveOrchestrator(null);
          release();
        });

      return { ok: true, summary: `Forge started for: "${action.description}"` };
    }

    case 'forgeResume': {
      if ((forgeCtx.depth ?? 0) >= 1) {
        return { ok: false, error: 'forgeResume blocked: recursion depth >= 1 (forge cannot spawn another forge)' };
      }

      if (!action.planId) {
        return { ok: false, error: 'forgeResume requires a planId' };
      }

      const existing = getActiveOrchestrator();
      if (existing?.isRunning) {
        const activeId = getActiveForgeId();
        return {
          ok: false,
          error: `A forge is already running${activeId ? ` (${activeId})` : ''}. Cancel it first with forgeCancel.`,
        };
      }

      const planOpts: HandlePlanCommandOpts = {
        workspaceCwd: forgeCtx.workspaceCwd,
        taskStore: forgeCtx.taskStore,
      };
      const found = await findPlanFile(forgeCtx.plansDir, action.planId);
      if (!found) {
        return { ok: false, error: `Plan not found: ${action.planId}` };
      }

      if (shouldRouteForgeResumeToPlanRun(found.header.status)) {
        if (!forgeCtx.planCtx) {
          return {
            ok: false,
            error: `Plan ${found.header.planId} is ${found.header.status}, but planRun is not configured in this context.`,
          };
        }

        const runResult = await executePlanAction(
          { type: 'planRun', planId: found.header.planId },
          ctx,
          forgeCtx.planCtx,
        );
        return runResult.ok
          ? { ok: true, summary: runResult.summary ?? `Plan run started for ${found.header.planId}.` }
          : runResult;
      }

      const progress = await buildProgressCallbacks(
        ctx,
        forgeCtx,
        found.header.status === 'DRAFT' || found.header.status === 'REVIEW'
          ? `Resuming forge review for **${found.header.planId}** from ${found.header.status} status...`
          : `Resuming forge review for **${found.header.planId}**...`,
      );
      const orchestrator = forgeCtx.orchestratorFactory();
      setActiveOrchestrator(orchestrator, [ctx.channelId, ctx.threadParentId]);
      const watchdog = forgeCtx.longRunWatchdog;
      const watchdogRunId = buildForgeWatchdogId('resume', ctx, found.header.planId);
      if (watchdog) {
        try {
          await watchdog.start({
            runId: watchdogRunId,
            channelId: ctx.channelId,
            messageId: ctx.messageId,
            stillRunningDelayMs: forgeCtx.longRunStillRunningDelayMs,
          });
        } catch (err) {
          forgeCtx.log?.warn({ err, runId: watchdogRunId, planId: found.header.planId }, 'forge:action:resume watchdog start failed');
        }
      }

      const release = await acquireWriterLock();
      void orchestrator
        .resume(found.header.planId, found.filePath, found.header.title, progress.onProgress, progress.onEvent)
        .then(async (result) => {
          let outcome: 'succeeded' | 'failed' = result.error ? 'failed' : 'succeeded';
          const postedSummary = await progress.sendPlanSummary(result.planSummary);
          if (!postedSummary) outcome = 'failed';
          if (watchdog) {
            try {
              await watchdog.complete(watchdogRunId, { outcome });
            } catch (err) {
              forgeCtx.log?.warn({ err, runId: watchdogRunId, planId: found.header.planId }, 'forge:action:resume watchdog complete failed');
            }
          }
        })
        .catch(async (err) => {
          forgeCtx.log?.error({ err, planId: action.planId }, 'forge:action:resume failed');
          if (watchdog) {
            try {
              await watchdog.complete(watchdogRunId, { outcome: 'failed' });
            } catch (completeErr) {
              forgeCtx.log?.warn({ err: completeErr, runId: watchdogRunId, planId: found.header.planId }, 'forge:action:resume watchdog complete failed');
            }
          }
        })
        .finally(() => {
          progress.dispose();
          setActiveOrchestrator(null);
          release();
        });

      return { ok: true, summary: `Forge resumed for ${found.header.planId}: "${found.header.title}"` };
    }

    case 'forgeStatus': {
      const orch = getActiveOrchestrator();
      const runningPlanIds = getRunningPlanIds();
      const planRunsSuffix = runningPlanIds.size > 0
        ? ` Plan runs active: ${[...runningPlanIds].join(', ')}.`
        : '';
      if (orch?.isRunning) {
        const activeId = getActiveForgeId();
        return { ok: true, summary: `Forge is running${activeId ? `: ${activeId}` : ''}.${planRunsSuffix}` };
      }
      return { ok: true, summary: `No forge is currently running.${planRunsSuffix}` };
    }

    case 'forgeCancel': {
      const orch = getActiveOrchestrator();
      if (!orch?.isRunning) {
        return { ok: false, error: 'No forge is currently running.' };
      }
      orch.requestCancel('forgeCancel action');
      const activeId = getActiveForgeId();
      return { ok: true, summary: `Cancel requested${activeId ? ` for ${activeId}` : ''}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function forgeActionsPromptSection(): string {
  return `### Forge (Plan Drafting + Audit)

**forgeCreate** — Start a new forge run (drafts a plan, then audits/revises iteratively):
\`\`\`
<discord-action>{"type":"forgeCreate","description":"Add retry logic to webhook handler","context":"Optional extra context or requirements"}</discord-action>
\`\`\`
- \`description\` (required): What to plan for.
- \`context\` (optional): Additional context appended to the plan.

**forgeResume** — Continue an existing plan based on its current status:
\`\`\`
<discord-action>{"type":"forgeResume","planId":"plan-042"}</discord-action>
\`\`\`
- \`planId\` (required): The plan ID to resume.
- DRAFT / REVIEW: re-enter the forge audit/revise loop.
- APPROVED / IMPLEMENTING: route to \`planRun\` and continue implementation.

**forgeStatus** — Check if a forge is currently running:
\`\`\`
<discord-action>{"type":"forgeStatus"}</discord-action>
\`\`\`

**forgeCancel** — Cancel a running forge:
\`\`\`
<discord-action>{"type":"forgeCancel"}</discord-action>
\`\`\`

#### Forge Guidelines
- Only one forge can run at a time. Check status before starting a new one.
- Forge runs are asynchronous — progress updates are posted to the channel.
- Use forgeResume when you want DiscoClaw to pick up a plan again; the next step depends on the plan's status.
- Re-audit with forgeResume after manual plan edits when the plan is still in DRAFT or REVIEW.`;
}
