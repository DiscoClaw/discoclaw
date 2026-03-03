import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { ForgeOrchestrator } from './forge-commands.js';
import type { TaskStore } from '../tasks/store.js';
import { looksLikePlanId, findPlanFile, listPlanFiles } from './plan-commands.js';
import type { HandlePlanCommandOpts } from './plan-commands.js';
import { buildPlanSummary } from './forge-commands.js';
import { createStreamingProgress } from './streaming-progress.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { taskThreadCache } from '../tasks/thread-cache.js';
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
};

type SendFn = (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;

function resolveSendFn(channel: unknown): SendFn | null {
  if (!channel || typeof channel !== 'object') return null;
  const maybeSend = (channel as { send?: unknown }).send;
  if (typeof maybeSend !== 'function') return null;
  return maybeSend.bind(channel) as SendFn;
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
  sendPlanSummary: (summary?: string) => Promise<void>;
  dispose: () => void;
}> {
  const fallback = {
    onProgress: forgeCtx.onProgress,
    onEvent: undefined as ReturnType<typeof createStreamingProgress>['onEvent'] | undefined,
    sendPlanSummary: async (summary?: string) => {
      if (!summary) return;
      await forgeCtx.onProgress(summary, { force: true });
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
    );
    const enableToolAwareStreaming = forgeCtx.toolAwareStreaming ?? true;
    return {
      onProgress: controller.onProgress,
      onEvent: enableToolAwareStreaming ? controller.onEvent : undefined,
      sendPlanSummary: async (summary?: string) => {
        if (!summary) return;
        try {
          await send({ content: summary, allowedMentions: NO_MENTIONS });
        } catch {
          // best-effort
        }
      },
      dispose: controller.dispose,
    };
  } catch (err) {
    forgeCtx.log?.warn({ err, channelId: ctx.channelId }, 'forge:action progress channel unavailable');
    return fallback;
  }
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
      const progress = await buildProgressCallbacks(ctx, forgeCtx, `Starting forge: ${action.description}`);
      const orchestrator = forgeCtx.orchestratorFactory({
        existingTaskId: threadTask.existingTaskId,
        taskDescription: threadTask.taskDescription,
      });
      setActiveOrchestrator(orchestrator, ctx.channelId);

      // Fire and forget — forge runs asynchronously with progress callbacks.
      const release = await acquireWriterLock();
      void orchestrator
        .run(action.description, progress.onProgress, action.context, progress.onEvent)
        .then(async (result) => {
          await progress.sendPlanSummary(result.planSummary);
        })
        .catch((err) => {
          forgeCtx.log?.error({ err }, 'forge:action:create failed');
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

      const progress = await buildProgressCallbacks(
        ctx,
        forgeCtx,
        `Re-auditing **${found.header.planId}**...`,
      );
      const orchestrator = forgeCtx.orchestratorFactory();
      setActiveOrchestrator(orchestrator, ctx.channelId);

      const release = await acquireWriterLock();
      void orchestrator
        .resume(found.header.planId, found.filePath, found.header.title, progress.onProgress, progress.onEvent)
        .then(async (result) => {
          await progress.sendPlanSummary(result.planSummary);
        })
        .catch((err) => {
          forgeCtx.log?.error({ err, planId: action.planId }, 'forge:action:resume failed');
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

**forgeResume** — Resume auditing an existing plan (re-enters the audit/revise loop):
\`\`\`
<discord-action>{"type":"forgeResume","planId":"plan-042"}</discord-action>
\`\`\`
- \`planId\` (required): The plan ID to resume.

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
- Use forgeResume to re-audit a plan that needs another pass (e.g., after manual edits).`;
}
