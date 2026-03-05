import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';
import {
  findPlanFile,
  listPlanFiles,
  updatePlanFileStatus,
  handlePlanCommand,
  preparePlanRun,
  closePlanIfComplete,
  resolvePlanHeaderTaskId,
  NO_PHASES_SENTINEL,
} from './plan-commands.js';
import type { HandlePlanCommandOpts, PlanFileHeader } from './plan-commands.js';
import { runNextPhase, resolveProjectCwd, readPhasesFile, buildPostRunSummary } from './plan-manager.js';
import type { PlanRunEvent } from './plan-manager.js';
import type { TaskStore } from '../tasks/store.js';
import type { LongRunWatchdog } from './long-run-watchdog.js';
import {
  acquireWriterLock,
  addRunningPlan,
  removeRunningPlan,
  isPlanRunning,
} from './forge-plan-registry.js';
import { NO_MENTIONS } from './allowed-mentions.js';
import { createStreamingProgress } from './streaming-progress.js';
import { adaptPlanRunEventText } from './runtime-event-text-adapter.js';
import { runtimeSupportsNativeThinkingStream } from './runtime-signal-budget.js';

const DEFAULT_PLAN_PHASE_TIMEOUT_MS = 1_800_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanActionRequest =
  | { type: 'planList'; status?: string }
  | { type: 'planShow'; planId: string }
  | { type: 'planApprove'; planId: string }
  | { type: 'planClose'; planId: string }
  | { type: 'planCreate'; description: string; context?: string }
  | { type: 'planRun'; planId: string };

const PLAN_TYPE_MAP: Record<PlanActionRequest['type'], true> = {
  planList: true,
  planShow: true,
  planApprove: true,
  planClose: true,
  planCreate: true,
  planRun: true,
};
export const PLAN_ACTION_TYPES = new Set<string>(Object.keys(PLAN_TYPE_MAP));

export type PlanContext = {
  plansDir: string;
  workspaceCwd: string;
  taskStore: TaskStore;
  log?: LoggerLike;
  /** Recursion depth — 0 for user/cron origins, 1+ for action-triggered sub-invocations. */
  depth?: number;
  /** Runtime adapter needed for planRun phase execution. */
  runtime?: RuntimeAdapter;
  /** Model name for phase execution. */
  model?: string;
  /** Timeout per phase in ms. */
  phaseTimeoutMs?: number;
  /** Max audit fix attempts per phase. */
  maxAuditFixAttempts?: number;
  /** Max phases to run in a single planRun invocation. */
  maxPlanRunPhases?: number;
  /** Callback for progress messages. */
  onProgress?: (msg: string) => Promise<void>;
  /** Whether runtime event-driven tool/text streaming is enabled. Defaults to true. */
  toolAwareStreaming?: boolean;
  /** When true, suppresses the post-run completion message to the originating channel. Used by forge auto-implement. */
  skipCompletionNotify?: boolean;
  /** Called with the final completion content after the run finishes. Allows callers (e.g. forge auto-implement) to consume the outcome without a race against Discord status messages. */
  onRunComplete?: (content: string) => Promise<void>;
  /** Called after a backing task is closed, so callers can sync Discord thread tags. */
  onTaskClosed?: (taskId: string) => void;
  /** Optional lifecycle watchdog for long-running plan runs. */
  longRunWatchdog?: Pick<LongRunWatchdog, 'start' | 'complete'>;
  /** Optional override for watchdog still-running check-in delay. */
  longRunStillRunningDelayMs?: number;
};

type MessageEditTarget = {
  edit(opts: { content: string; allowedMentions?: unknown }): Promise<unknown>;
};

type MessageSendTarget = {
  send(opts: { content: string; allowedMentions: unknown }): Promise<unknown>;
};

function asMessageEditTarget(value: unknown): MessageEditTarget | null {
  if (!value || typeof value !== 'object' || !('edit' in value)) return null;
  const edit = (value as { edit?: unknown }).edit;
  return typeof edit === 'function' ? (value as MessageEditTarget) : null;
}

function asMessageSendTarget(value: unknown): MessageSendTarget | null {
  if (!value || typeof value !== 'object' || !('send' in value)) return null;
  const send = (value as { send?: unknown }).send;
  return typeof send === 'function' ? (value as MessageSendTarget) : null;
}

function extractPhaseStopMessage(phaseResult: { result: string } & Record<string, unknown>): string {
  const error = phaseResult.error;
  if (typeof error === 'string' && error.trim()) return error;
  const message = phaseResult.message;
  if (typeof message === 'string' && message.trim()) return message;
  return phaseResult.result;
}

function buildPlanRunWatchdogId(planId: string, ctx: ActionContext): string {
  return `plan-action:${ctx.channelId}:${ctx.messageId}:${planId}`;
}

const ARCHIVED_THREAD_STOP_MESSAGE = 'Thread is archived (50083)';

function errorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function isArchivedThreadError(err: unknown): boolean {
  return errorCode(err) === 50083;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executePlanAction(
  action: PlanActionRequest,
  ctx: ActionContext,
  planCtx: PlanContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'planList': {
      const plans = await listPlanFiles(planCtx.plansDir);

      if (plans.length === 0) {
        return { ok: true, summary: 'No plans found.' };
      }

      // Filter by status if provided.
      let filtered = plans;
      if (action.status) {
        const statusUpper = action.status.toUpperCase();
        filtered = plans.filter((p) => p.header.status.toUpperCase() === statusUpper);
        if (filtered.length === 0) {
          return { ok: true, summary: `No plans with status "${action.status}".` };
        }
      }

      // Sort by planId.
      filtered.sort((a, b) => a.header.planId.localeCompare(b.header.planId));

      const lines = filtered.map(
        (p) => {
          const taskId = resolvePlanHeaderTaskId(p.header);
          return `\`${p.header.planId}\` [${p.header.status}] — ${p.header.title}${taskId ? ` (task: \`${taskId}\`)` : ''}`;
        },
      );
      return { ok: true, summary: lines.join('\n') };
    }

    case 'planShow': {
      if (!action.planId) {
        return { ok: false, error: 'planShow requires a planId' };
      }

      const found = await findPlanFile(planCtx.plansDir, action.planId);
      if (!found) {
        return { ok: false, error: `Plan not found: ${action.planId}` };
      }

      const taskId = resolvePlanHeaderTaskId(found.header);
      const lines = [
        `**${found.header.planId}** — ${found.header.title}`,
        `Status: ${found.header.status}`,
        ...(taskId ? [`Task: \`${taskId}\``] : []),
        `Project: ${found.header.project}`,
        `Created: ${found.header.created}`,
      ];
      return { ok: true, summary: lines.join('\n') };
    }

    case 'planApprove': {
      if (!action.planId) {
        return { ok: false, error: 'planApprove requires a planId' };
      }

      const found = await findPlanFile(planCtx.plansDir, action.planId);
      if (!found) {
        return { ok: false, error: `Plan not found: ${action.planId}` };
      }

      if (found.header.status === 'IMPLEMENTING') {
        return {
          ok: false,
          error: `Plan is currently being implemented. Cancel it first.`,
        };
      }

      await updatePlanFileStatus(found.filePath, 'APPROVED');

      // Update backing task to in_progress.
      const taskId = resolvePlanHeaderTaskId(found.header);
      if (taskId) {
        try {
          planCtx.taskStore.update(taskId, { status: 'in_progress' });
        } catch {
          // best-effort
        }
      }

      return { ok: true, summary: `Plan **${found.header.planId}** approved for implementation.` };
    }

    case 'planClose': {
      if (!action.planId) {
        return { ok: false, error: 'planClose requires a planId' };
      }

      const found = await findPlanFile(planCtx.plansDir, action.planId);
      if (!found) {
        return { ok: false, error: `Plan not found: ${action.planId}` };
      }

      if (found.header.status === 'IMPLEMENTING') {
        return {
          ok: false,
          error: `Plan is currently being implemented. Cancel it first.`,
        };
      }

      await updatePlanFileStatus(found.filePath, 'CLOSED');

      // Close backing task.
      const taskId = resolvePlanHeaderTaskId(found.header);
      if (taskId) {
        try {
          planCtx.taskStore.close(taskId, 'Plan closed');
        } catch {
          // best-effort
        }
        try {
          planCtx.onTaskClosed?.(taskId);
        } catch {
          // best-effort
        }
      }

      return { ok: true, summary: `Plan **${found.header.planId}** closed.` };
    }

    case 'planCreate': {
      if (!action.description) {
        return { ok: false, error: 'planCreate requires a description' };
      }

      const opts: HandlePlanCommandOpts = {
        workspaceCwd: planCtx.workspaceCwd,
        taskStore: planCtx.taskStore,
      };

      const result = await handlePlanCommand(
        { action: 'create', args: action.description, context: action.context },
        opts,
      );

      // handlePlanCommand returns a human-readable string. Check for error patterns.
      if (result.startsWith('Failed') || result.startsWith('Plan command error')) {
        return { ok: false, error: result };
      }

      return { ok: true, summary: result };
    }

    case 'planRun': {
      if ((planCtx.depth ?? 0) >= 1) {
        return { ok: false, error: 'planRun blocked: recursion depth >= 1 (plan run cannot spawn another plan run)' };
      }

      if (!action.planId) {
        return { ok: false, error: 'planRun requires a planId' };
      }

      if (!planCtx.runtime || !planCtx.model) {
        return { ok: false, error: 'planRun requires runtime and model to be configured' };
      }

      if (isPlanRunning(action.planId)) {
        return { ok: false, error: `A multi-phase run is already in progress for ${action.planId}.` };
      }
      const runPlanId = action.planId;

      const planOpts: HandlePlanCommandOpts = {
        workspaceCwd: planCtx.workspaceCwd,
        taskStore: planCtx.taskStore,
      };

      // Validate the plan and get phase info synchronously.
      const prepResult = await preparePlanRun(action.planId, planOpts);
      if ('error' in prepResult) {
        const isAllDone = prepResult.error.startsWith(NO_PHASES_SENTINEL);
        return isAllDone
          ? { ok: true, summary: `All phases already complete for ${action.planId}.` }
          : { ok: false, error: prepResult.error };
      }

      let projectCwd: string;
      try {
        projectCwd = resolveProjectCwd(prepResult.planContent, planCtx.workspaceCwd);
      } catch (err) {
        return { ok: false, error: `Failed to resolve project directory: ${String(err instanceof Error ? err.message : err)}` };
      }

      const maxPhases = planCtx.maxPlanRunPhases ?? 50;
      const timeoutMs = planCtx.phaseTimeoutMs ?? DEFAULT_PLAN_PHASE_TIMEOUT_MS;
      const onProgress = planCtx.onProgress ?? (async () => {});

      const PROGRESS_THROTTLE_MS = 3_000;

      addRunningPlan(action.planId);
      const watchdogRunId = buildPlanRunWatchdogId(runPlanId, ctx);
      const watchdog = planCtx.longRunWatchdog;
      if (watchdog) {
        try {
          await watchdog.start({
            runId: watchdogRunId,
            channelId: ctx.channelId,
            messageId: ctx.messageId,
            sessionKey: runPlanId,
            stillRunningDelayMs: planCtx.longRunStillRunningDelayMs,
          });
        } catch (err) {
          planCtx.log?.warn({ err, runId: watchdogRunId, planId: runPlanId }, 'plan:action:run watchdog start failed');
        }
      }

      // Fire and forget — plan run executes asynchronously.
      let watchdogOutcome: 'succeeded' | 'failed' = 'failed';
      void (async () => {
        // Send initial status message and set up live edits (best-effort).
        let runChannel: MessageSendTarget | undefined;
        let fallbackChannel: MessageSendTarget | undefined;
        let statusMsg: MessageEditTarget | undefined;
        let streamingController: ReturnType<typeof createStreamingProgress> | undefined;
        let lastStatusEditAt = 0;
        let archivedThreadDetected = false;

        const markArchivedThread = (err: unknown, source: string): void => {
          if (archivedThreadDetected) return;
          archivedThreadDetected = true;
          planCtx.log?.warn({ err, planId: runPlanId, source }, 'plan:action:run thread archived');
        };

        const phaseStartMessages = new Map<string, MessageEditTarget>();
        const onPlanEvent = async (event: PlanRunEvent): Promise<void> => {
          if (event.type === 'phase_start') {
            if (phaseStartMessages.has(event.phase.id) || !runChannel) return;
            try {
              const sent = await runChannel.send({
                content: adaptPlanRunEventText(event),
                allowedMentions: NO_MENTIONS,
              });
              const editable = asMessageEditTarget(sent);
              if (editable) {
                phaseStartMessages.set(event.phase.id, editable);
              }
            } catch (err) {
              planCtx.log?.warn({ err, planId: runPlanId, phaseId: event.phase.id }, 'plan:action:run phase-start post failed');
            }
          } else if (event.type === 'phase_complete') {
            const phaseMsg = phaseStartMessages.get(event.phase.id);
            if (!phaseMsg) return;
            try {
              await phaseMsg.edit({
                content: adaptPlanRunEventText(event),
                allowedMentions: NO_MENTIONS,
              });
            } catch {
              // best-effort
            }
          }
        };

        try {
          const channel = await ctx.client.channels.fetch(ctx.channelId);
          runChannel = asMessageSendTarget(channel) ?? undefined;
        } catch {
          // best-effort — phase-start posts and completion fall back gracefully
        }
        if (ctx.threadParentId && ctx.threadParentId !== ctx.channelId) {
          try {
            const parent = await ctx.client.channels.fetch(ctx.threadParentId);
            fallbackChannel = asMessageSendTarget(parent) ?? undefined;
          } catch {
            // best-effort
          }
        }

        if (!planCtx.skipCompletionNotify && runChannel) {
          try {
            const sent = await runChannel.send({
              content: `**Plan run started:** \`${runPlanId}\` — starting phase ${prepResult.nextPhase.id}: ${prepResult.nextPhase.title}`,
              allowedMentions: NO_MENTIONS,
            });
            statusMsg = asMessageEditTarget(sent) ?? undefined;
          } catch {
            // best-effort — missing status message is non-fatal
          }
        }

        if (statusMsg) {
          streamingController = createStreamingProgress(statusMsg, PROGRESS_THROTTLE_MS, {
            useNativeTextFallback: runtimeSupportsNativeThinkingStream(planCtx.runtime!.id),
            throwOnFatal: true,
            onFatalError: (err) => markArchivedThread(err, 'streaming-progress'),
          });
        }

        const runtimeEventAdapter: ((evt: EngineEvent) => void) | undefined =
          (planCtx.toolAwareStreaming ?? true) ? streamingController?.onEvent : undefined;

        const phaseOpts = {
          runtime: planCtx.runtime!,
          model: planCtx.model!,
          projectCwd,
          addDirs: [] as string[],
          timeoutMs,
          workspaceCwd: planCtx.workspaceCwd,
          log: planCtx.log,
          maxAuditFixAttempts: planCtx.maxAuditFixAttempts,
          onEvent: runtimeEventAdapter,
          onPlanEvent,
        };

        // Edit the status message, honouring throttle. Pass force=true to bypass throttle.
        async function editStatus(content: string, force = false): Promise<void> {
          if (streamingController) {
            await streamingController.onProgress(content, { force });
            return;
          }
          if (!statusMsg) return;
          const now = Date.now();
          if (!force && now - lastStatusEditAt < PROGRESS_THROTTLE_MS) return;
          lastStatusEditAt = now;
          try {
            await statusMsg.edit({ content, allowedMentions: NO_MENTIONS });
          } catch (err) {
            if (isArchivedThreadError(err)) {
              markArchivedThread(err, 'status-edit');
              throw err;
            }
            // best-effort
          }
        }

        try {
          // Compose onProgress with status message edits.
          const wrappedOnProgress = async (msg: string): Promise<void> => {
            await onProgress(msg);
            await editStatus(msg);
          };

          let phasesRun = 0;
          let stopReason: string | undefined;
          let stopMessage: string | undefined;
          let hitMaxPhases = false;
          try {
            for (let i = 0; i < maxPhases; i++) {
              if (archivedThreadDetected) {
                stopReason = 'error';
                stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
                break;
              }
              const release = await acquireWriterLock();
              let phaseResult;
              try {
                phaseResult = await runNextPhase(prepResult.phasesFilePath, prepResult.planFilePath, phaseOpts, wrappedOnProgress);
              } finally {
                release();
              }
              if (archivedThreadDetected) {
                stopReason = 'error';
                stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
                break;
              }
              if (phaseResult.result === 'done') {
                phasesRun++;
                // Force-edit on phase completion boundary.
                try {
                  await editStatus(`**Plan run in progress:** \`${action.planId}\` — phase complete (${phasesRun} done so far)`, true);
                } catch (err) {
                  if (isArchivedThreadError(err)) {
                    markArchivedThread(err, 'phase-complete-edit');
                    stopReason = 'error';
                    stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
                    break;
                  }
                  throw err;
                }
              } else if (phaseResult.result === 'nothing_to_run') {
                // Force-edit to reflect no more phases.
                try {
                  await editStatus(`**Plan run finishing:** \`${action.planId}\` — no more phases to run`, true);
                } catch (err) {
                  if (isArchivedThreadError(err)) {
                    markArchivedThread(err, 'no-more-phases-edit');
                    stopReason = 'error';
                    stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
                  } else {
                    throw err;
                  }
                }
                break;
              } else {
                // Any error/stale/corrupt/audit_failed/retry_blocked stops the loop.
                stopReason = phaseResult.result;
                stopMessage = extractPhaseStopMessage(phaseResult as { result: string } & Record<string, unknown>);
                planCtx.log?.warn({ planId: runPlanId, result: phaseResult.result, phasesRun }, 'plan:action:run stopped');
                // Force-edit to reflect stop.
                try {
                  await editStatus(`**Plan run stopped:** \`${runPlanId}\` — ${stopMessage ?? stopReason}`, true);
                } catch (err) {
                  if (isArchivedThreadError(err)) {
                    markArchivedThread(err, 'stop-edit');
                    stopReason = 'error';
                    stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
                  } else {
                    throw err;
                  }
                }
                break;
              }
              if (i === maxPhases - 1) {
                hitMaxPhases = true;
              }
              // Yield between phases.
              await new Promise(resolve => setImmediate(resolve));
            }
          } catch (loopErr) {
            if (isArchivedThreadError(loopErr)) {
              markArchivedThread(loopErr, 'phase-loop');
              stopReason = 'error';
              stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
            } else {
              throw loopErr;
            }
          }
          if (archivedThreadDetected && !stopReason) {
            stopReason = 'error';
            stopMessage = ARCHIVED_THREAD_STOP_MESSAGE;
          }
          planCtx.log?.info({ planId: runPlanId, phasesRun }, 'plan:action:run complete');

          // Auto-close plan if all phases are terminal
          let autoClosed = false;
          let runError: unknown;
          try {
            const closeResult = await closePlanIfComplete(
              prepResult.phasesFilePath,
              prepResult.planFilePath,
              planCtx.taskStore,
              acquireWriterLock,
              planCtx.log,
              planCtx.onTaskClosed,
            );
            autoClosed = closeResult.closed;
          } catch (err) {
            runError = err;
            planCtx.log?.error({ err, planId: runPlanId }, 'plan:action:run failed');
          }

          // Build the final outcome content — always, so onRunComplete can use it even when skipCompletionNotify is set.
          const lines: string[] = [
            `**Plan run complete:** \`${runPlanId}\``,
            `Phases run: ${phasesRun}`,
          ];
          if (hitMaxPhases && !stopReason) {
            lines.push(`Stopped: reached max-phase limit (${maxPhases})`);
          }
          if (stopReason) {
            lines.push(`Stopped: ${stopMessage ?? stopReason}`);
          }
          if (runError) {
            lines.push(`Error: ${runError instanceof Error ? runError.message : String(runError)}`);
          }
          if (autoClosed) {
            lines.push('Plan auto-closed — all phases terminal.');
          }
          try {
            const phases = readPhasesFile(prepResult.phasesFilePath, { log: planCtx.log });
            const budget = Math.max(0, 2000 - lines.join('\n').length - 50);
            const summary = buildPostRunSummary(phases, budget);
            if (summary) {
              lines.push(summary);
            }
          } catch (summaryErr) {
            planCtx.log?.error({ err: summaryErr, planId: runPlanId }, 'plan:action:run summary failed');
          }
          const finalContent = lines.join('\n');

          // Edit status message to show final outcome (preserved for backwards compatibility).
          if (!planCtx.skipCompletionNotify) {
            let posted = false;
            if (statusMsg) {
              // Edit the existing status message in place.
              try {
                await statusMsg.edit({ content: finalContent, allowedMentions: NO_MENTIONS });
                posted = true;
              } catch (err) {
                if (isArchivedThreadError(err)) markArchivedThread(err, 'final-status-edit');
              }
            }
            // Post a standalone completion message as a new chat message.
            if (runChannel) {
              try {
                await runChannel.send({ content: finalContent, allowedMentions: NO_MENTIONS });
                posted = true;
              } catch (err) {
                if (isArchivedThreadError(err)) markArchivedThread(err, 'final-run-channel-send');
              }
            } else if (!statusMsg) {
              // Fall back to sending a new message if we never got runChannel or statusMsg.
              try {
                const channel = await ctx.client.channels.fetch(ctx.channelId);
                const sendTarget = asMessageSendTarget(channel);
                if (sendTarget) {
                  await sendTarget.send({ content: finalContent, allowedMentions: NO_MENTIONS });
                  posted = true;
                }
              } catch {
                // best-effort
              }
            }
            if (!posted && fallbackChannel) {
              try {
                await fallbackChannel.send({ content: finalContent, allowedMentions: NO_MENTIONS });
              } catch {
                // best-effort
              }
            }
          }

          // Notify caller (e.g. forge auto-implement) with the final content — best-effort.
          try {
            await planCtx.onRunComplete?.(finalContent);
          } catch {
            // best-effort
          }
          const runHadFailure = Boolean(stopReason || runError || hitMaxPhases || archivedThreadDetected);
          watchdogOutcome = runHadFailure ? 'failed' : 'succeeded';
        } finally {
          streamingController?.dispose();
        }
      })().catch((err) => {
        planCtx.log?.error({ err, planId: runPlanId }, 'plan:action:run failed');
      }).finally(async () => {
        if (watchdog) {
          try {
            await watchdog.complete(watchdogRunId, { outcome: watchdogOutcome });
          } catch (err) {
            planCtx.log?.warn({ err, runId: watchdogRunId, planId: runPlanId }, 'plan:action:run watchdog complete failed');
          }
        }
      }).finally(() => {
        removeRunningPlan(runPlanId);
      }).catch((err) => {
        planCtx.log?.error({ err, planId: runPlanId }, 'plan:action:run unhandled rejection in callback');
      });

      return { ok: true, summary: `Plan run started for **${action.planId}** — starting phase ${prepResult.nextPhase.id}: ${prepResult.nextPhase.title}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function planActionsPromptSection(): string {
  return `### Plan Management

**planList** — List all plans (optionally filter by status):
\`\`\`
<discord-action>{"type":"planList"}</discord-action>
<discord-action>{"type":"planList","status":"APPROVED"}</discord-action>
\`\`\`
- \`status\` (optional): Filter by plan status (DRAFT, REVIEW, APPROVED, IMPLEMENTING, CLOSED).

**planShow** — Show plan details:
\`\`\`
<discord-action>{"type":"planShow","planId":"plan-042"}</discord-action>
\`\`\`
- \`planId\` (required): The plan ID or backing task ID (legacy header IDs are still accepted).

**planApprove** — Approve a plan for implementation:
\`\`\`
<discord-action>{"type":"planApprove","planId":"plan-042"}</discord-action>
\`\`\`
- \`planId\` (required): The plan ID to approve.

**planClose** — Close/abandon a plan:
\`\`\`
<discord-action>{"type":"planClose","planId":"plan-042"}</discord-action>
\`\`\`
- \`planId\` (required): The plan ID to close.

**planCreate** — Create a new plan (drafts a plan file and backing task):
\`\`\`
<discord-action>{"type":"planCreate","description":"Add retry logic to webhook handler","context":"Optional extra context"}</discord-action>
\`\`\`
- \`description\` (required): What the plan is for.
- \`context\` (optional): Additional context appended to the plan.

**planRun** — Execute all remaining phases of a plan (fire-and-forget):
\`\`\`
<discord-action>{"type":"planRun","planId":"plan-042"}</discord-action>
\`\`\`
- \`planId\` (required): The plan ID to execute.
- The plan must be in APPROVED or IMPLEMENTING status. Phases run sequentially with the writer lock. On successful completion of all phases, the plan is auto-closed and the backing task is closed.

#### Plan Guidelines
- Use planList to check existing plans before creating duplicates.
- Plans go through statuses: DRAFT → REVIEW → APPROVED → IMPLEMENTING → CLOSED.
- Use forgeCreate to draft+audit a plan, or planCreate for a bare plan file without forge auditing.
- Approving a plan marks its backing task as in_progress.
- Use planRun to execute approved plans autonomously.`;
}
