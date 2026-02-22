import fs from 'node:fs/promises';
import path from 'node:path';
import type { CredentialCheckResult } from '../health/credential-check.js';
import { checkDiscordToken, checkOpenAiKey } from '../health/credential-check.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { TaskStore } from '../tasks/store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatusCronEntry = {
  name: string;
  schedule: string | undefined;
  nextRun: Date | null;
};

export type StatusPaFile = {
  label: string;
  exists: boolean;
};

export type StatusSnapshot = {
  uptimeMs: number;
  lastMessageAt: number | null;
  crons: StatusCronEntry[];
  openTaskCount: number;
  durableItemCount: number;
  rollingSummaryCharCount: number;
  apiChecks: CredentialCheckResult[];
  paFiles: StatusPaFile[];
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseStatusCommand(content: string): true | null {
  const normalized = String(content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '!status') return true;
  return null;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export type CollectStatusOpts = {
  startedAt: number;
  lastMessageAt: number | null;
  scheduler: CronScheduler | null;
  taskStore: TaskStore | null;
  durableDataDir: string | null;
  summaryDataDir: string | null;
  discordToken: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  paFilePaths: Array<{ label: string; path: string }>;
};

async function countDurableItems(dir: string): Promise<number> {
  let total = 0;
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          'items' in parsed &&
          Array.isArray((parsed as any).items)
        ) {
          total += (parsed as any).items.filter((i: any) => i?.status === 'active').length;
        }
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // dir missing or unreadable
  }
  return total;
}

async function countRollingSummaryChars(dir: string): Promise<number> {
  let total = 0;
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          'summary' in parsed &&
          typeof (parsed as any).summary === 'string'
        ) {
          total += (parsed as any).summary.length;
        }
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // dir missing or unreadable
  }
  return total;
}

async function checkPaFiles(
  filePaths: Array<{ label: string; path: string }>,
): Promise<StatusPaFile[]> {
  return Promise.all(
    filePaths.map(async ({ label, path: filePath }) => {
      try {
        await fs.access(filePath, fs.constants.R_OK);
        return { label, exists: true };
      } catch {
        return { label, exists: false };
      }
    }),
  );
}

export async function collectStatusSnapshot(opts: CollectStatusOpts): Promise<StatusSnapshot> {
  const now = Date.now();

  const [durableItemCount, rollingSummaryCharCount, apiChecks, paFiles] = await Promise.all([
    opts.durableDataDir ? countDurableItems(opts.durableDataDir) : Promise.resolve(0),
    opts.summaryDataDir ? countRollingSummaryChars(opts.summaryDataDir) : Promise.resolve(0),
    Promise.all([
      checkDiscordToken(opts.discordToken),
      checkOpenAiKey({ apiKey: opts.openaiApiKey, baseUrl: opts.openaiBaseUrl }),
    ]),
    checkPaFiles(opts.paFilePaths),
  ]);

  return {
    uptimeMs: now - opts.startedAt,
    lastMessageAt: opts.lastMessageAt,
    crons: opts.scheduler?.listJobs() ?? [],
    openTaskCount: opts.taskStore?.list().length ?? 0,
    durableItemCount,
    rollingSummaryCharCount,
    apiChecks,
    paFiles,
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatNextRun(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'imminent';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

export function renderStatusReport(snapshot: StatusSnapshot, botDisplayName = 'Discoclaw'): string {
  const lines: string[] = [];

  lines.push(`${botDisplayName} Status`);

  // Uptime & last message
  lines.push(`Uptime: ${formatUptime(snapshot.uptimeMs)}`);
  if (snapshot.lastMessageAt !== null) {
    const agoMs = Date.now() - snapshot.lastMessageAt;
    lines.push(`Last message: ${formatTimeAgo(agoMs)} ago`);
  } else {
    lines.push('Last message: none since startup');
  }

  // Crons
  if (snapshot.crons.length === 0) {
    lines.push('Crons: none');
  } else {
    lines.push(`Crons (${snapshot.crons.length}):`);
    for (const job of snapshot.crons) {
      const next = job.nextRun
        ? formatNextRun(job.nextRun)
        : job.schedule
          ? 'stopped'
          : 'manual/webhook';
      lines.push(`  ${job.name}: next=${next}`);
    }
  }

  // Tasks
  lines.push(`Open tasks: ${snapshot.openTaskCount}`);

  // Memory
  lines.push(
    `Memory: durable=${snapshot.durableItemCount} items, summaries=${snapshot.rollingSummaryCharCount} chars`,
  );

  // API connectivity
  const apiParts = snapshot.apiChecks.map((r) => {
    const tag = r.status === 'ok' ? 'ok' : r.status === 'skip' ? 'skip' : 'FAIL';
    const detail = r.message ? ` (${r.message})` : '';
    return `${r.name}: ${tag}${detail}`;
  });
  lines.push(`API: ${apiParts.length > 0 ? apiParts.join(', ') : 'no checks'}`);

  // Workspace PA files
  const paAllOk = snapshot.paFiles.length > 0 && snapshot.paFiles.every((f) => f.exists);
  const paParts = snapshot.paFiles.map((f) => `${f.label}: ${f.exists ? 'ok' : 'MISSING'}`);
  const paSuffix = paParts.length > 0 ? paParts.join(', ') : 'none configured';
  lines.push(`Workspace PA: ${paAllOk ? 'ok' : 'DEGRADED'} — ${paSuffix}`);

  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}
