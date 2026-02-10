import { Cron } from 'croner';
import type { CronJob, ParsedCronDef } from './types.js';
import type { LoggerLike } from '../discord/action-types.js';

export type CronTickHandler = (job: CronJob) => void | Promise<void>;

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private handler: CronTickHandler;
  private log?: LoggerLike;

  constructor(handler: CronTickHandler, log?: LoggerLike) {
    this.handler = handler;
    this.log = log;
  }

  register(id: string, threadId: string, guildId: string, name: string, def: ParsedCronDef): CronJob {
    const existing = this.jobs.get(id);

    // Create the cron instance first so invalid schedules don't clobber an existing job.
    const job: CronJob = { id, threadId, guildId, name, def, cron: null, running: false };
    const cron = new Cron(def.schedule, { timezone: def.timezone }, () => {
      // Fire-and-forget: errors handled inside the handler.
      void this.handler(job);
    });
    job.cron = cron;

    if (existing) {
      existing.cron?.stop();
      existing.cron = null;
      this.jobs.delete(id);
    }

    this.jobs.set(id, job);
    this.log?.info({ jobId: id, schedule: def.schedule, timezone: def.timezone }, 'cron:registered');
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
    // Recreate the cron instance to (re)start scheduling.
    job.cron?.stop();
    job.cron = new Cron(job.def.schedule, { timezone: job.def.timezone }, () => {
      void this.handler(job);
    });
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
