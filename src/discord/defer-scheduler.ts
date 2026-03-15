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
  createdAt: Date;
  runsAt: Date;
};

export type LoopSchedulerAction = {
  intervalSeconds: number;
};

export type LoopSchedulerJob<
  Act extends LoopSchedulerAction = LoopSchedulerAction,
  Ctx = unknown,
  Meta = unknown,
> = {
  action: Act;
  context: Ctx;
  meta: Meta;
};

export type LoopSchedulerRun<
  Act extends LoopSchedulerAction = LoopSchedulerAction,
  Ctx = unknown,
  Meta = unknown,
> = LoopSchedulerJob<Act, Ctx, Meta> & {
  id: number;
  createdAt: Date;
  scheduledAt: Date;
  nextRunAt: Date;
  consecutiveFailures: number;
};

export type LoopJobInfo<
  Act extends LoopSchedulerAction = LoopSchedulerAction,
  Meta = unknown,
> = {
  id: number;
  action: Act;
  meta: Meta;
  createdAt: Date;
  nextRunAt: Date;
  running: boolean;
  consecutiveFailures: number;
};

export type LoopSchedulerOptions<
  Act extends LoopSchedulerAction = LoopSchedulerAction,
  Ctx = unknown,
  Meta = unknown,
> = {
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  maxConcurrent: number;
  maxConsecutiveFailures?: number;
  isTerminalError?: (err: unknown) => boolean;
  tickHandler: (run: LoopSchedulerRun<Act, Ctx, Meta>) => Promise<void> | void;
  log?: {
    warn?: (obj: unknown, msg?: string) => void;
  };
};

type LoopCreateResult<Act extends LoopSchedulerAction, Meta> =
  | { ok: true; job: LoopJobInfo<Act, Meta> }
  | { ok: false; error: string };

type LoopInternalJob<
  Act extends LoopSchedulerAction,
  Ctx,
  Meta,
> = LoopSchedulerJob<Act, Ctx, Meta> & {
  id: number;
  createdAt: Date;
  nextRunAt: Date;
  running: boolean;
  consecutiveFailures: number;
  timer: ReturnType<typeof setTimeout> | null;
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

    const createdAt = new Date();
    this.activeJobs.set(id, { id, action: job.action, createdAt, runsAt });

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

  /** Cancel all pending jobs and clear their timers. Returns the number of jobs cancelled.
   *  Already-running jobs (timer fired, handler still executing) are left alone. */
  cancelAll(): number {
    const count = this.timers.size;
    for (const [id, timer] of this.timers.entries()) {
      clearTimeout(timer);
      this.activeJobs.delete(id);
    }
    this.timers.clear();
    return count;
  }
}

export class LoopScheduler<
  Act extends LoopSchedulerAction = LoopSchedulerAction,
  Ctx = unknown,
  Meta = unknown,
> {
  private nextId = 1;
  private readonly activeJobs = new Map<number, LoopInternalJob<Act, Ctx, Meta>>();
  private readonly minIntervalSeconds: number;
  private readonly maxIntervalSeconds: number;
  private readonly maxConcurrent: number;
  private readonly maxConsecutiveFailures: number;
  private readonly isTerminalError?: LoopSchedulerOptions<Act, Ctx, Meta>['isTerminalError'];
  private readonly tickHandler: LoopSchedulerOptions<Act, Ctx, Meta>['tickHandler'];
  private readonly log?: LoopSchedulerOptions<Act, Ctx, Meta>['log'];

  constructor(opts: LoopSchedulerOptions<Act, Ctx, Meta>) {
    this.minIntervalSeconds = opts.minIntervalSeconds;
    this.maxIntervalSeconds = opts.maxIntervalSeconds;
    this.maxConcurrent = opts.maxConcurrent;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.isTerminalError = opts.isTerminalError;
    this.tickHandler = opts.tickHandler;
    this.log = opts.log;
  }

  get concurrentCap(): number {
    return this.maxConcurrent;
  }

  create(job: LoopSchedulerJob<Act, Ctx, Meta>): LoopCreateResult<Act, Meta> {
    const intervalSeconds = job.action.intervalSeconds;
    if (!Number.isFinite(intervalSeconds)) {
      return { ok: false, error: 'intervalSeconds must be a number' };
    }
    if (intervalSeconds < this.minIntervalSeconds) {
      return {
        ok: false,
        error: `intervalSeconds must be at least ${this.minIntervalSeconds} seconds`,
      };
    }
    if (intervalSeconds > this.maxIntervalSeconds) {
      return {
        ok: false,
        error: `intervalSeconds cannot exceed ${this.maxIntervalSeconds} seconds`,
      };
    }
    if (this.activeJobs.size >= this.maxConcurrent) {
      return {
        ok: false,
        error: `Maximum of ${this.maxConcurrent} loops are already active`,
      };
    }

    const id = this.nextId++;
    const createdAt = new Date();
    const nextRunAt = new Date(createdAt.getTime() + intervalSeconds * 1000);
    const internalJob: LoopInternalJob<Act, Ctx, Meta> = {
      ...job,
      id,
      createdAt,
      nextRunAt,
      running: false,
      consecutiveFailures: 0,
      timer: null,
    };

    this.activeJobs.set(id, internalJob);
    this.scheduleNext(internalJob, intervalSeconds * 1000);
    return { ok: true, job: this.snapshot(internalJob) };
  }

  list(): LoopJobInfo<Act, Meta>[] {
    return [...this.activeJobs.values()]
      .map((job) => this.snapshot(job))
      .sort((a, b) => a.id - b.id);
  }

  cancel(id: number): boolean {
    const job = this.activeJobs.get(id);
    if (!job) return false;
    if (job.timer) clearTimeout(job.timer);
    this.activeJobs.delete(id);
    return true;
  }

  cancelAll(): number {
    const count = this.activeJobs.size;
    for (const job of this.activeJobs.values()) {
      if (job.timer) clearTimeout(job.timer);
    }
    this.activeJobs.clear();
    return count;
  }

  private snapshot(job: LoopInternalJob<Act, Ctx, Meta>): LoopJobInfo<Act, Meta> {
    return {
      id: job.id,
      action: job.action,
      meta: job.meta,
      createdAt: new Date(job.createdAt.getTime()),
      nextRunAt: new Date(job.nextRunAt.getTime()),
      running: job.running,
      consecutiveFailures: job.consecutiveFailures,
    };
  }

  private scheduleNext(job: LoopInternalJob<Act, Ctx, Meta>, delayMs: number): void {
    job.nextRunAt = new Date(Date.now() + delayMs);
    job.timer = setTimeout(() => {
      void this.runTick(job.id);
    }, delayMs);
    job.timer.unref?.();
  }

  private async runTick(id: number): Promise<void> {
    const job = this.activeJobs.get(id);
    if (!job) return;

    const scheduledAt = new Date(job.nextRunAt.getTime());
    this.scheduleNext(job, job.action.intervalSeconds * 1000);

    if (job.running) {
      this.log?.warn?.(
        { loopId: job.id, scheduledAt, nextRunAt: job.nextRunAt },
        'loop:skip (previous tick still active)',
      );
      return;
    }

    job.running = true;
    try {
      await Promise.resolve(this.tickHandler({
        id: job.id,
        action: job.action,
        context: job.context,
        meta: job.meta,
        createdAt: new Date(job.createdAt.getTime()),
        scheduledAt,
        nextRunAt: new Date(job.nextRunAt.getTime()),
        consecutiveFailures: job.consecutiveFailures,
      }));
      const current = this.activeJobs.get(id);
      if (current) current.consecutiveFailures = 0;
    } catch (err) {
      const current = this.activeJobs.get(id);
      if (!current) return;

      if (this.isTerminalError?.(err)) {
        this.log?.warn?.({ loopId: current.id, err }, 'loop:terminal failure, canceling');
        this.cancel(id);
        return;
      }

      current.consecutiveFailures += 1;
      this.log?.warn?.(
        { loopId: current.id, failures: current.consecutiveFailures, err },
        'loop:tick failed',
      );
      if (current.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.log?.warn?.(
          { loopId: current.id, failures: current.consecutiveFailures },
          'loop:max failures reached, canceling',
        );
        this.cancel(id);
      }
    } finally {
      const current = this.activeJobs.get(id);
      if (current) current.running = false;
    }
  }
}
