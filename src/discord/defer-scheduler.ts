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
  | { ok: true; id: number; runsAt: Date; delaySeconds: number }
  | { ok: false; error: string };

export type DeferJobInfo<Act extends DeferSchedulerAction = DeferSchedulerAction> = {
  id: number;
  action: Act;
  runsAt: Date;
};

export class DeferScheduler<Act extends DeferSchedulerAction = DeferSchedulerAction, Ctx = unknown> {
  private nextId = 1;
  private readonly activeJobs = new Map<number, DeferJobInfo<Act>>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly maxDelaySeconds: number;
  private readonly maxConcurrent: number;
  private readonly jobHandler: DeferSchedulerOptions<Act, Ctx>['jobHandler'];

  constructor(opts: DeferSchedulerOptions<Act, Ctx>) {
    this.maxDelaySeconds = opts.maxDelaySeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.jobHandler = opts.jobHandler;
  }

  /** Returns a snapshot of all currently pending jobs. */
  listActive(): DeferJobInfo<Act>[] {
    return [...this.activeJobs.values()];
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
    if (this.activeJobs.size >= this.maxConcurrent) {
      return {
        ok: false,
        error: `Maximum of ${this.maxConcurrent} deferred actions are already scheduled`,
      };
    }

    const id = this.nextId++;
    const runsAt = new Date(Date.now() + delaySeconds * 1000);
    const delayMs = delaySeconds * 1000;

    this.activeJobs.set(id, { id, action: job.action, runsAt });

    const invokeHandler = async () => {
      this.timers.delete(id);
      try {
        await Promise.resolve(this.jobHandler({ action: job.action, context: job.context, runsAt }));
      } finally {
        this.activeJobs.delete(id);
      }
    };

    const timer = setTimeout(invokeHandler, delayMs);
    this.timers.set(id, timer);

    return { ok: true, id, runsAt, delaySeconds };
  }

  /** Cancel a single pending job by ID. Returns true if the job existed and was cancelled. */
  cancel(id: number): boolean {
    const timer = this.timers.get(id);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(id);
    this.activeJobs.delete(id);
    return true;
  }

  /** Cancel all pending jobs and clear their timers. Returns the number of jobs cancelled. */
  cancelAll(): number {
    const count = this.timers.size;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.activeJobs.clear();
    return count;
  }
}
