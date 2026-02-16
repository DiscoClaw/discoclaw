import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from './action-types.js';
import type { ForgeOrchestrator } from './forge-commands.js';
import { looksLikePlanId, findPlanFile, listPlanFiles } from './plan-commands.js';
import type { HandlePlanCommandOpts } from './plan-commands.js';
import { buildPlanSummary } from './forge-commands.js';
import {
  getActiveOrchestrator,
  getActiveForgeId,
  acquireWriterLock,
  setActiveOrchestrator,
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
  orchestratorFactory: () => ForgeOrchestrator;
  plansDir: string;
  workspaceCwd: string;
  beadsCwd: string;
  /** Callback to send progress messages to the originating channel. */
  onProgress: (msg: string, opts?: { force?: boolean }) => Promise<void>;
  log?: LoggerLike;
};

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

      const orchestrator = forgeCtx.orchestratorFactory();
      setActiveOrchestrator(orchestrator);

      // Fire and forget — forge runs asynchronously with progress callbacks.
      const release = await acquireWriterLock();
      void orchestrator
        .run(action.description, forgeCtx.onProgress, action.context)
        .catch((err) => {
          forgeCtx.log?.error({ err }, 'forge:action:create failed');
        })
        .finally(() => {
          setActiveOrchestrator(null);
          release();
        });

      return { ok: true, summary: `Forge started for: "${action.description}"` };
    }

    case 'forgeResume': {
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
        beadsCwd: forgeCtx.beadsCwd,
      };
      const found = await findPlanFile(forgeCtx.plansDir, action.planId);
      if (!found) {
        return { ok: false, error: `Plan not found: ${action.planId}` };
      }

      const orchestrator = forgeCtx.orchestratorFactory();
      setActiveOrchestrator(orchestrator);

      const release = await acquireWriterLock();
      void orchestrator
        .resume(found.header.planId, found.filePath, found.header.title, forgeCtx.onProgress)
        .catch((err) => {
          forgeCtx.log?.error({ err, planId: action.planId }, 'forge:action:resume failed');
        })
        .finally(() => {
          setActiveOrchestrator(null);
          release();
        });

      return { ok: true, summary: `Forge resumed for ${found.header.planId}: "${found.header.title}"` };
    }

    case 'forgeStatus': {
      const orch = getActiveOrchestrator();
      if (orch?.isRunning) {
        const activeId = getActiveForgeId();
        return { ok: true, summary: `Forge is running${activeId ? `: ${activeId}` : ''}` };
      }
      return { ok: true, summary: 'No forge is currently running.' };
    }

    case 'forgeCancel': {
      const orch = getActiveOrchestrator();
      if (!orch?.isRunning) {
        return { ok: false, error: 'No forge is currently running.' };
      }
      orch.requestCancel();
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
