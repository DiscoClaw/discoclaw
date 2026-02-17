export type DeferSchedulerAction = {
  delaySeconds: number;
};

export type DeferSchedulerJob<Act extends DeferSchedulerAction = DeferSchedulerAction, Ctx = unknown> = {
  action: Act;
  context: Ctx;
};

export type DeferSchedulerRun<Act extends DeferSchedulerAction = DeferSchedulerAction, Ctx = unknown> =
  DeferSchedulerJob<Act, Ctx> & { runsAt: Date };

export type DeferSchedulerOptions<Act extends DeferSchedulerAction = DeferSchedulerAction, Ctx = unknown> = {
  maxDelaySeconds: number;
  maxConcurrent: number;
  jobHandler: (run: DeferSchedulerRun<Act, Ctx>) => Promise<void> | void;
};

type ScheduleResult =
  | { ok: true; runsAt: Date; delaySeconds: number }
  | { ok: false; error: string };

export class DeferScheduler<Act extends DeferSchedulerAction = DeferSchedulerAction, Ctx = unknown> {
  private activeCount = 0;
  private readonly maxDelaySeconds: number;
  private readonly maxConcurrent: number;
  private readonly jobHandler: DeferSchedulerOptions<Act, Ctx>['jobHandler'];

  constructor(opts: DeferSchedulerOptions<Act, Ctx>) {
    this.maxDelaySeconds = opts.maxDelaySeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.jobHandler = opts.jobHandler;
  }

  schedule(job: DeferSchedulerJob<Act, Ctx>): ScheduleResult {
    const delaySeconds = job.action.delaySeconds;
    if (!Number.isFinite(delaySeconds)) {
      return { ok: false, error: 'delaySeconds must be a number' };
    }
    if (delaySeconds <= 0) {
      return { ok: false, error: 'delaySeconds must be greater than zero' };
    }
    if (delaySeconds > this.maxDelaySeconds) {
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
    const runsAt = new Date(Date.now() + delaySeconds * 1000);
    const delayMs = delaySeconds * 1000;

    const invokeHandler = async () => {
      try {
        await Promise.resolve(this.jobHandler({ action: job.action, context: job.context, runsAt }));
      } finally {
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
    };

    setTimeout(invokeHandler, delayMs);

    return { ok: true, runsAt, delaySeconds };
  }
}
