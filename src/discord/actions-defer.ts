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

export type DeferListActionRequest = {
  type: 'deferList';
};

export type DeferActionRequestUnion = DeferActionRequest | DeferListActionRequest;

const DEFER_TYPES: ReadonlyArray<DeferActionRequestUnion['type']> = ['defer', 'deferList'];
export const DEFER_ACTION_TYPES = new Set<string>(DEFER_TYPES);

export type DeferredRun = DeferSchedulerRun<DeferActionRequest, ActionContext>;

export async function executeDeferAction(
  action: DeferActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const scheduler = ctx.deferScheduler;
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

export function executeDeferListAction(
  ctx: ActionContext,
): DiscordActionResult {
  const scheduler = ctx.deferScheduler;
  if (!scheduler) {
    return { ok: false, error: 'Deferred actions are not configured for this bot' };
  }

  const active = scheduler.listActive();
  if (active.length === 0) {
    return { ok: true, summary: 'No pending deferred actions.' };
  }

  const lines = active.map((job, i) => {
    const remainingSec = Math.max(0, Math.floor((job.runsAt.getTime() - Date.now()) / 1000));
    const action = job.action as DeferActionRequest;
    const channel = action.channel ?? 'unknown';
    const prompt = action.prompt ?? '';
    return `${i + 1}. channel=${channel} | remaining=${formatDuration(remainingSec)} | runsAt=${fmtTime(job.runsAt)} | prompt="${prompt}"`;
  });

  return { ok: true, summary: `Pending deferred actions (${active.length}):\n${lines.join('\n')}` };
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
