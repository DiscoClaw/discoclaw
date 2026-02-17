import type { ActionContext, DiscordActionResult } from './actions.js';
import { fmtTime } from './action-utils.js';
import type { DeferScheduler, DeferSchedulerRun } from './defer-scheduler.js';

export type DeferActionRequest = {
  type: 'defer';
  channel: string;
  prompt: string;
  // Seconds to wait before re-invoking the runtime.
  delaySeconds: number;
};

const DEFER_TYPES: ReadonlyArray<DeferActionRequest['type']> = ['defer'];
export const DEFER_ACTION_TYPES = new Set<string>(DEFER_TYPES);

interface DeferActionContext extends ActionContext {
  deferScheduler?: DeferScheduler;
}

export type DeferredRun = DeferSchedulerRun<DeferActionRequest, ActionContext>;

export async function executeDeferAction(
  action: DeferActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const scheduler = (ctx as DeferActionContext).deferScheduler;
  if (!scheduler) {
    return { ok: false, error: 'Deferred actions are not configured for this bot' };
  }

  const channel = action.channel?.trim();
  if (!channel) {
    return { ok: false, error: 'Deferred actions require a target channel' };
  }
  const prompt = action.prompt?.trim();
  if (!prompt) {
    return { ok: false, error: 'Deferred actions require a prompt to re-run' };
  }

  const delaySeconds = action.delaySeconds;
  if (!Number.isFinite(delaySeconds)) {
    return { ok: false, error: 'delaySeconds must be a valid number' };
  }

  const normalizedAction: DeferActionRequest = {
    ...action,
    channel,
    prompt,
    delaySeconds,
  };

  const result = scheduler.schedule({ action: normalizedAction, context: ctx });
  if (!result.ok) {
    return { ok: false, error: buildDeferRejection(channel, result.error) };
  }

  const delayLabel = formatDuration(result.delaySeconds);
  const when = fmtTime(result.runsAt);
  return {
    ok: true,
    summary: `Deferred follow-up scheduled for ${channel} in ${delayLabel} (runs at ${when})`,
  };
}

function formatDuration(seconds: number): string {
  const parts: string[] = [];
  let remaining = seconds;
  const hours = Math.floor(remaining / 3600);
  if (hours > 0) {
    parts.push(`${hours}h`);
    remaining -= hours * 3600;
  }
  const minutes = Math.floor(remaining / 60);
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remaining -= minutes * 60;
  }
  const secs = Math.floor(remaining);
  if (secs > 0 || parts.length === 0) {
    parts.push(`${secs}s`);
  }
  return parts.join(' ');
}

function buildDeferRejection(channel: string, reason: string): string {
  const target = channel || 'requested channel';
  return `Deferred follow-up for ${target} rejected: ${reason}`;
}
