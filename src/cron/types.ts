import type { Cron } from 'croner';

export type ParsedCronDef = {
  triggerType: 'schedule' | 'webhook' | 'manual';  // discriminator; 'schedule' for cron-fired automations
  schedule?: string;  // 5-field cron expression (e.g., "0 7 * * 1-5"); absent for webhook/manual automations
  timezone: string;   // IANA timezone (e.g., "America/Los_Angeles"), default: system timezone
  channel: string;    // target channel name or ID (e.g., "general")
  prompt: string;     // the instruction text for the runtime
};

export type CronJob = {
  id: string;         // unique job ID (thread ID)
  cronId: string;     // stable ID (e.g., "cron-a1b2c3d4"), independent of thread ID
  threadId: string;   // Discord forum thread ID
  guildId: string;    // guild that owns this cron
  name: string;       // thread name (human-readable job name)
  def: ParsedCronDef;
  cron: Cron | null;  // croner instance (null when disabled)
  running: boolean;   // overlap guard
  allowedActions?: string[];  // per-job restriction: only these Discord action types may be emitted; undefined = unrestricted
};
