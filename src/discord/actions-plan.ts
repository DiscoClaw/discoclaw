import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter } from '../runtime/types.js';
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
import {
  acquireWriterLock,
  addRunningPlan,
  removeRunningPlan,
  isPlanRunning,
} from './forge-plan-registry.js';
import { NO_MENTIONS } from './allowed-mentions.js';

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
  /** When true, suppresses the post-run completion message to the originating channel. Used by forge auto-implement. */
  skipCompletionNotify?: boolean;
  /** Called with the final completion content after the run finishes. Allows callers (e.g. forge auto-implement) to consume the outcome without a race against Discord status messages. */
  onRunComplete?: (content: string) => Promise<void>;
};

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

      const lines = [
        `**${found.header.planId}** — ${found.header.title}`,
        `Status: ${found.header.status}`,
        `Task: \`${resolvePlanHeaderTaskId(found.header)}\``,
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

      // Fire and forget — plan run executes asynchronously.
      void (async () => {
        // Send initial status message and set up live edits (best-effort).
        let runChannel: { send: (opts: { content: string; allowedMentions: unknown }) => Promise<unknown> } | undefined;
        let statusMsg: { edit: (opts: { content: string; allowedMentions: unknown }) => Promise<unknown> } | undefined;
        let lastStatusEditAt = 0;

        const postedPhaseStarts = new Set<string>();
        const onPlanEvent = async (event: PlanRunEvent): Promise<void> => {
          if (event.type !== 'phase_start') return;
          if (postedPhaseStarts.has(event.phase.id) || !runChannel) return;
          postedPhaseStarts.add(event.phase.id);
          try {
            await runChannel.send({
              content: `Starting phase **${event.phase.id}**: ${event.phase.title}`,
              allowedMentions: NO_MENTIONS,
            });
          } catch (err) {
            planCtx.log?.warn({ err, planId: runPlanId, phaseId: event.phase.id }, 'plan:action:run phase-start post failed');
          }
        };

        const phaseOpts = {
          runtime: planCtx.runtime!,
          model: planCtx.model!,
          projectCwd,
          addDirs: [] as string[],
          timeoutMs,
          workspaceCwd: planCtx.workspaceCwd,
          log: planCtx.log,
          maxAuditFixAttempts: planCtx.maxAuditFixAttempts,
          onPlanEvent,
        };

        try {
          const channel = await ctx.client.channels.fetch(ctx.channelId);
          if (channel && 'send' in channel) {
            runChannel = channel as any;
          }
        } catch {
          // best-effort — phase-start posts and completion fall back gracefully
        }

        if (!planCtx.skipCompletionNotify && runChannel) {
          try {
            const sent = await runChannel.send({
              content: `**Plan run started:** \`${runPlanId}\` — starting phase ${prepResult.nextPhase.id}: ${prepResult.nextPhase.title}`,
              allowedMentions: NO_MENTIONS,
            });
            if (sent && typeof (sent as any).edit === 'function') {
              statusMsg = sent as any;
            }
          } catch {
            // best-effort — missing status message is non-fatal
          }
        }

        // Edit the status message, honouring throttle. Pass force=true to bypass throttle.
        async function editStatus(content: string, force = false): Promise<void> {
          if (!statusMsg) return;
          const now = Date.now();
          if (!force && now - lastStatusEditAt < PROGRESS_THROTTLE_MS) return;
          lastStatusEditAt = now;
          try {
            await statusMsg.edit({ content, allowedMentions: NO_MENTIONS });
          } catch {
            // best-effort
          }
        }

        // Compose onProgress with status message edits.
        const wrappedOnProgress = async (msg: string): Promise<void> => {
          await onProgress(msg);
          await editStatus(msg);
        };

        let phasesRun = 0;
        let stopReason: string | undefined;
        let stopMessage: string | undefined;
        let hitMaxPhases = false;
        for (let i = 0; i < maxPhases; i++) {
          const release = await acquireWriterLock();
          let phaseResult;
          try {
            phaseResult = await runNextPhase(prepResult.phasesFilePath, prepResult.planFilePath, phaseOpts, wrappedOnProgress);
          } finally {
            release();
          }

          if (phaseResult.result === 'done') {
            phasesRun++;
            // Force-edit on phase completion boundary.
            await editStatus(`**Plan run in progress:** \`${action.planId}\` — phase complete (${phasesRun} done so far)`, true);
          } else if (phaseResult.result === 'nothing_to_run') {
            // Force-edit to reflect no more phases.
            await editStatus(`**Plan run finishing:** \`${action.planId}\` — no more phases to run`, true);
            break;
          } else {
            // Any error/stale/corrupt/audit_failed/retry_blocked stops the loop.
            stopReason = phaseResult.result;
            stopMessage = (phaseResult as any).error ?? (phaseResult as any).message ?? phaseResult.result;
            planCtx.log?.warn({ planId: runPlanId, result: phaseResult.result, phasesRun }, 'plan:action:run stopped');
            // Force-edit to reflect stop.
            await editStatus(`**Plan run stopped:** \`${runPlanId}\` — ${stopMessage ?? stopReason}`, true);
            break;
          }

          if (i === maxPhases - 1) {
            hitMaxPhases = true;
          }

          // Yield between phases.
          await new Promise(resolve => setImmediate(resolve));
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

        // Edit status message to show final outcome, or send a new message if no statusMsg.
        if (!planCtx.skipCompletionNotify) {
          try {
            if (statusMsg) {
              // Edit the existing status message in place.
              try {
                await statusMsg.edit({ content: finalContent, allowedMentions: NO_MENTIONS });
              } catch {
                // best-effort
              }
            } else {
              // Fall back to sending a new message if we never got a statusMsg.
              if (runChannel) {
                await runChannel.send({ content: finalContent, allowedMentions: NO_MENTIONS });
              } else {
                const channel = await ctx.client.channels.fetch(ctx.channelId);
                if (channel && 'send' in channel) {
                  await (channel as any).send({ content: finalContent, allowedMentions: NO_MENTIONS });
                }
              }
            }
          } catch {
            // best-effort — do not rethrow
          }
        }

        // Notify caller (e.g. forge auto-implement) with the final content — best-effort.
        try {
          await planCtx.onRunComplete?.(finalContent);
        } catch {
          // best-effort
        }
      })().catch((err) => {
        planCtx.log?.error({ err, planId: runPlanId }, 'plan:action:run failed');
      }).finally(() => {
        removeRunningPlan(runPlanId);
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
