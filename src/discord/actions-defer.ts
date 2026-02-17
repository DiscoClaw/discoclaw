import type { ActionContext, DiscordActionResult } from './actions.js';
import { fmtTime } from './action-utils.js';

export type DeferActionRequest = {
  type: 'defer';
  channel: string;
  prompt: string;
  // Seconds to wait before re-invoking the runtime.
  delaySeconds: number;
};

interface DeferActionContext extends ActionContext {
  deferScheduler?: DeferScheduler;
}

export type DeferredRun = {
  action: DeferActionRequest;
  context: ActionContext;
  runsAt: Date;
};

export type DeferSchedulerOptions = {
  maxDelaySeconds: number;
  maxConcurrent: number;
  jobHandler: (run: DeferredRun) => Promise<void> | void;
};

type DeferSchedulerJob = {
  action: DeferActionRequest;
  context: ActionContext;
};

type ScheduleResult =
  | { ok: true; runsAt: Date; delaySeconds: number; channel: string }
  | { ok: false; error: string };

export class DeferScheduler {
  private activeCount = 0;
  private readonly maxDelaySeconds: number;
  private readonly maxConcurrent: number;
  private readonly jobHandler: DeferSchedulerOptions['jobHandler'];

  constructor(opts: DeferSchedulerOptions) {
    this.maxDelaySeconds = opts.maxDelaySeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.jobHandler = opts.jobHandler;
  }

  schedule(job: DeferSchedulerJob): ScheduleResult {
    if (!Number.isFinite(job.action.delaySeconds)) {
      return { ok: false, error: 'delaySeconds must be a number' };
    }
    if (job.action.delaySeconds <= 0) {
      return { ok: false, error: 'delaySeconds must be greater than zero' };
    }
    if (job.action.delaySeconds > this.maxDelaySeconds) {
      return {
        ok: false,
        error: `delaySeconds cannot exceed ${this.maxDelaySeconds} seconds`,
      };
    }
    if (this.activeCount >= this.maxConcurrent) {
      return {
        ok: false,
        error: `Maximum of ${this.maxConcurrent} deferred actions are already scheduled`,
      };
    }

    this.activeCount++;
    const runsAt = new Date(Date.now() + job.action.delaySeconds * 1000);
    const delayMs = job.action.delaySeconds * 1000;

    const invokeHandler = async () => {
      try {
        await Promise.resolve(this.jobHandler({ action: job.action, context: job.context, runsAt }));
      } finally {
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
    };

    setTimeout(invokeHandler, delayMs);

    return { ok: true, runsAt, delaySeconds: job.action.delaySeconds, channel: job.action.channel };
  }
}

export async function executeDeferAction(
  action: DeferActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const scheduler = (ctx as DeferActionContext).deferScheduler;
  if (!scheduler) {
    return { ok: false, error: 'Deferred actions are not configured for this bot' };
  }

  if (!action.channel || !action.channel.trim()) {
    return { ok: false, error: 'Deferred actions require a target channel' };
  }
  if (!action.prompt || !action.prompt.trim()) {
    return { ok: false, error: 'Deferred actions require a prompt to re-run' };
  }

  const delaySeconds = action.delaySeconds;
  if (!Number.isFinite(delaySeconds)) {
    return { ok: false, error: 'delaySeconds must be a valid number' };
  }

  const result = scheduler.schedule({ action, context: ctx });
  if (!result.ok) return { ok: false, error: result.error };

  const delayLabel = formatDuration(result.delaySeconds);
  const when = fmtTime(result.runsAt);
  return {
    ok: true,
    summary: `Deferred follow-up scheduled for ${action.channel} in ${delayLabel} (runs at ${when})`,
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
