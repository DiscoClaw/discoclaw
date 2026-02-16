import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from './action-types.js';
import {
  findPlanFile,
  listPlanFiles,
  updatePlanFileStatus,
  handlePlanCommand,
} from './plan-commands.js';
import type { HandlePlanCommandOpts, PlanFileHeader } from './plan-commands.js';
import { bdUpdate, bdClose } from '../beads/bd-cli.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanActionRequest =
  | { type: 'planList'; status?: string }
  | { type: 'planShow'; planId: string }
  | { type: 'planApprove'; planId: string }
  | { type: 'planClose'; planId: string }
  | { type: 'planCreate'; description: string; context?: string };

const PLAN_TYPE_MAP: Record<PlanActionRequest['type'], true> = {
  planList: true,
  planShow: true,
  planApprove: true,
  planClose: true,
  planCreate: true,
};
export const PLAN_ACTION_TYPES = new Set<string>(Object.keys(PLAN_TYPE_MAP));

export type PlanContext = {
  plansDir: string;
  workspaceCwd: string;
  beadsCwd: string;
  log?: LoggerLike;
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

#### Plan Guidelines
- Use planList to check existing plans before creating duplicates.
- Plans go through statuses: DRAFT → REVIEW → APPROVED → IMPLEMENTING → CLOSED.
- Use forgeCreate to draft+audit a plan, or planCreate for a bare plan file without forge auditing.
- Approving a plan marks its backing bead as in_progress.`;
}
