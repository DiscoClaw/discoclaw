import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from './action-types.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import {
  findPlanFile,
  listPlanFiles,
  updatePlanFileStatus,
  handlePlanCommand,
  preparePlanRun,
  closePlanIfComplete,
  NO_PHASES_SENTINEL,
} from './plan-commands.js';
import type { HandlePlanCommandOpts, PlanFileHeader } from './plan-commands.js';
import { runNextPhase, resolveProjectCwd } from './plan-manager.js';
import { bdUpdate, bdClose } from '../beads/bd-cli.js';
import {
  acquireWriterLock,
  addRunningPlan,
  removeRunningPlan,
  isPlanRunning,
} from './forge-plan-registry.js';

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
  beadsCwd: string;
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
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executePlanAction(
  action: PlanActionRequest,
  _ctx: ActionContext,
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
        (p) => `\`${p.header.planId}\` [${p.header.status}] — ${p.header.title}${p.header.beadId ? ` (bead: \`${p.header.beadId}\`)` : ''}`,
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
        `Bead: \`${found.header.beadId}\``,
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

      // Update backing bead to in_progress.
      if (found.header.beadId) {
        try {
          await bdUpdate(found.header.beadId, { status: 'in_progress' }, planCtx.beadsCwd);
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

      // Close backing bead.
      if (found.header.beadId) {
        try {
          await bdClose(found.header.beadId, 'Plan closed', planCtx.beadsCwd);
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
        beadsCwd: planCtx.beadsCwd,
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

      const planOpts: HandlePlanCommandOpts = {
        workspaceCwd: planCtx.workspaceCwd,
        beadsCwd: planCtx.beadsCwd,
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
      const timeoutMs = planCtx.phaseTimeoutMs ?? 30 * 60_000;
      const onProgress = planCtx.onProgress ?? (async () => {});

      addRunningPlan(action.planId);

      // Fire and forget — plan run executes asynchronously.
      void (async () => {
        const phaseOpts = {
          runtime: planCtx.runtime!,
          model: planCtx.model!,
          projectCwd,
          addDirs: [] as string[],
          timeoutMs,
          workspaceCwd: planCtx.workspaceCwd,
          log: planCtx.log,
          maxAuditFixAttempts: planCtx.maxAuditFixAttempts,
        };

        let phasesRun = 0;
        for (let i = 0; i < maxPhases; i++) {
          const release = await acquireWriterLock();
          let phaseResult;
          try {
            phaseResult = await runNextPhase(prepResult.phasesFilePath, prepResult.planFilePath, phaseOpts, onProgress);
          } finally {
            release();
          }

          if (phaseResult.result === 'done') {
            phasesRun++;
          } else if (phaseResult.result === 'nothing_to_run') {
            break;
          } else {
            // Any error/stale/corrupt/audit_failed/retry_blocked stops the loop.
            planCtx.log?.warn({ planId: action.planId, result: phaseResult.result, phasesRun }, 'plan:action:run stopped');
            break;
          }

          // Yield between phases.
          await new Promise(resolve => setImmediate(resolve));
        }
        planCtx.log?.info({ planId: action.planId, phasesRun }, 'plan:action:run complete');

        // Auto-close plan if all phases are terminal
        await closePlanIfComplete(
          prepResult.phasesFilePath,
          prepResult.planFilePath,
          planCtx.beadsCwd,
          acquireWriterLock,
          planCtx.log,
        );
      })().catch((err) => {
        planCtx.log?.error({ err, planId: action.planId }, 'plan:action:run failed');
      }).finally(() => {
        removeRunningPlan(action.planId);
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
- \`planId\` (required): The plan ID or backing bead ID.

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

**planCreate** — Create a new plan (drafts a plan file and backing bead):
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
- The plan must be in APPROVED or IMPLEMENTING status. Phases run sequentially with the writer lock. On successful completion of all phases, the plan is auto-closed and the backing bead is closed.

#### Plan Guidelines
- Use planList to check existing plans before creating duplicates.
- Plans go through statuses: DRAFT → REVIEW → APPROVED → IMPLEMENTING → CLOSED.
- Use forgeCreate to draft+audit a plan, or planCreate for a bare plan file without forge auditing.
- Approving a plan marks its backing bead as in_progress.
- Use planRun to execute approved plans autonomously.`;
}
