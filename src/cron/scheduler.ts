import { Cron } from 'croner';
import type { CronJob, ParsedCronDef } from './types.js';
import type { LoggerLike } from '../logging/logger-like.js';

export type CronTickHandler = (job: CronJob) => void | Promise<void>;

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private handler: CronTickHandler;
  private log?: LoggerLike;

  constructor(handler: CronTickHandler, log?: LoggerLike) {
    this.handler = handler;
    this.log = log;
  }

  register(id: string, threadId: string, guildId: string, name: string, def: ParsedCronDef, cronId?: string): CronJob {
    const existing = this.jobs.get(id);
    const isScheduled = !def.triggerType || def.triggerType === 'schedule';

    // Create the job shell first; create the cron timer only for schedule-type agents.
    const job: CronJob = { id, cronId: cronId ?? existing?.cronId ?? '', threadId, guildId, name, def, cron: null, running: false };
    if (isScheduled) {
      // Construct timer first so invalid schedules don't clobber an existing job.
      const cron = new Cron(def.schedule, { timezone: def.timezone }, () => {
        // Fire-and-forget: errors handled inside the handler.
        void this.handler(job);
      });
      job.cron = cron;
    }

    if (existing) {
      existing.cron?.stop();
      existing.cron = null;
      this.jobs.delete(id);
    }

    this.jobs.set(id, job);
    this.log?.info({ jobId: id, triggerType: def.triggerType ?? 'schedule', schedule: def.schedule, timezone: def.timezone }, 'cron:registered');
    return job;
  }

  unregister(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cron?.stop();
    job.cron = null;
    this.jobs.delete(id);
    this.log?.info({ jobId: id }, 'cron:unregistered');
    return true;
  }

  disable(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cron?.stop();
    job.cron = null;
    this.log?.info({ jobId: id }, 'cron:disabled');
    return true;
  }

  enable(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    const isScheduled = !job.def.triggerType || job.def.triggerType === 'schedule';
    job.cron?.stop();
    if (isScheduled) {
      // Recreate the cron instance to (re)start scheduling.
      job.cron = new Cron(job.def.schedule, { timezone: job.def.timezone }, () => {
        void this.handler(job);
      });
    } else {
      job.cron = null;
    }
    this.log?.info({ jobId: id }, 'cron:enabled');
    return true;
  }

  reload(id: string, newDef: ParsedCronDef): CronJob | null {
    const existing = this.jobs.get(id);
    if (!existing) return null;
    return this.register(id, existing.threadId, existing.guildId, existing.name, newDef);
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): Array<{ id: string; name: string; schedule: string; timezone: string; nextRun: Date | null }> {
    return Array.from(this.jobs.values()).map((job) => ({
      id: job.id,
      name: job.name,
      schedule: job.def.schedule,
      timezone: job.def.timezone,
      nextRun: job.cron?.nextRun() ?? null,
    }));
  }

  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.cron?.stop();
      job.cron = null;
    }
    this.jobs.clear();
    this.log?.info('cron:stopAll');
  }
}
