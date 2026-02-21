import type { ForgeResult } from './forge-commands.js';
import type { LoggerLike } from '../logging/logger-like.js';

export type ForgeAutoImplementRunSummary = {
  summary: string;
};

export type ForgeAutoImplementDeps = {
  planApprove: (planId: string) => Promise<void>;
  planRun: (planId: string) => Promise<ForgeAutoImplementRunSummary>;
  isPlanRunning: (planId: string) => boolean;
  log?: LoggerLike;
};

export type ForgeAutoImplementOptions = {
  planId: string;
  result: ForgeResult;
};

export type ForgeAutoImplementOutcome =
  | { status: 'auto'; planId: string; summary: string }
  | { status: 'manual'; message: string };

const SEVERITY_LABELS: Record<string, string> = {
  blocking: 'blocking severity',
  medium: 'medium severity',
  minor: 'minor severity',
  suggestion: 'suggestion-level',
};

export async function autoImplementForgePlan(
  opts: ForgeAutoImplementOptions,
  deps: ForgeAutoImplementDeps,
): Promise<ForgeAutoImplementOutcome> {
  const { planId, result } = opts;
  const { planApprove, planRun, isPlanRunning, log } = deps;
  const verdict = result.finalVerdict;
  const normalizedVerdict = typeof verdict === 'string' ? verdict.toLowerCase() : '';
  const severity = normalizedVerdict && normalizedVerdict !== 'none' ? normalizedVerdict : undefined;

  if (!planId) {
    return manualOutcome('', 'Plan ID missing from the forge output.');
  }

  if (result.error) {
    return manualOutcome(planId, `Forge failed: ${result.error}`);
  }

  if (result.reachedMaxRounds) {
    return manualOutcome(planId, 'Forge reached the audit cap (CAP_REACHED) and left concerns unresolved. Manual review is required.');
  }

  if (!verdict || verdict === 'CANCELLED' || verdict === 'error') {
    return manualOutcome(planId, 'Forge did not emit a ready verdict. Please inspect the plan before proceeding.');
  }

  if (normalizedVerdict === 'blocking') {
    return manualOutcome(planId, 'Review the flagged concerns before implementing.', normalizedVerdict);
  }

  if (isPlanRunning(planId)) {
    return manualOutcome(planId, 'A plan run is already in progress for this plan.');
  }

  try {
    await planApprove(planId);
    log?.info({ planId }, 'forge:auto-implement: plan auto-approved');
  } catch (err) {
    const reason = `Auto-approval failed: ${String(err)}`;
    log?.error({ err, planId }, 'forge:auto-implement: approval failed');
    return manualOutcome(planId, reason);
  }

  let runSummary: string;
  try {
    ({ summary: runSummary } = await planRun(planId));
    log?.info({ planId }, 'forge:auto-implement: implementation run completed');
  } catch (err) {
    const reason = `Auto-run failed: ${String(err)}`;
    log?.error({ err, planId }, 'forge:auto-implement: run failed');
    return manualOutcome(planId, reason);
  }

  const warningMessage = severity ? `Forge reported ${severityLabel(severity)} concerns.` : undefined;
  const summaryParts: string[] = [];
  if (warningMessage) summaryParts.push(warningMessage);
  if (runSummary) summaryParts.push(runSummary);
  const summary = summaryParts.join('\n\n');

  return { status: 'auto', planId, summary };
}

function manualOutcome(planId: string, reason?: string, severity?: string): ForgeAutoImplementOutcome {
  const messageParts: string[] = [];
  if (severity && severity !== 'none') {
    messageParts.push(`Forge reported ${severityLabel(severity)} concerns.`);
  }
  if (reason) {
    messageParts.push(reason);
  }

  if (planId) {
    messageParts.push(
      `Reply \`!plan approve ${planId}\` to approve, then \`!plan run ${planId}\` to start implementation. Or \`!plan show ${planId}\` to review first.`,
    );
  } else {
    messageParts.push('Review the plan manually, then use `!plan approve <id>` and `!plan run <id>` to continue.');
  }

  return { status: 'manual', message: messageParts.join(' ') };
}

function severityLabel(value: string): string {
  if (value in SEVERITY_LABELS) {
    return SEVERITY_LABELS[value];
  }
  return `${value} severity`;
}
