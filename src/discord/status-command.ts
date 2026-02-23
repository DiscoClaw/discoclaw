import fs from 'node:fs/promises';
import path from 'node:path';
import type { CredentialCheckResult } from '../health/credential-check.js';
import { checkDiscordToken, checkOpenAiKey, checkOpenRouterKey } from '../health/credential-check.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { TaskStore } from '../tasks/store.js';

const DEFAULT_API_CHECK_TIMEOUT_MS = 5000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseActiveDurableItems(value: unknown): number {
  const obj = asRecord(value);
  if (!obj) return 0;
  const items = obj.items;
  if (!Array.isArray(items)) return 0;
  return items.filter((item) => {
    const entry = asRecord(item);
    return entry?.status === 'active';
  }).length;
}

function parseSummaryLength(value: unknown): number {
  const obj = asRecord(value);
  if (!obj) return 0;
  return typeof obj.summary === 'string' ? obj.summary.length : 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Runtime context provided by the bot startup to the !status command handler.
 * Carries values that aren't already available on BotParams (note: BotParams
 * exposes token only at the module level, not to individual handlers).
 */
export type StatusCommandContext = {
  /** Timestamp (Date.now()) when the process started. */
  startedAt: number;
  /** Mutable ref updated by the message handler on every allowlisted message. */
  lastMessageAt: { current: number | null };
  /** Discord bot token used for the live /users/@me connectivity probe. */
  discordToken: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  /** Workspace PA files to probe for health. Label is the display name, path is the FS path. */
  paFilePaths: Array<{ label: string; path: string }>;
  /** Timeout for live API connectivity checks (ms). Defaults to 5 000 ms. */
  apiCheckTimeoutMs?: number;
  /** Workspace working directory (used for display / future probes). */
  workspaceCwd: string;
  /** Rolling summary data directory for char-count stats. */
  summaryDataDir: string;
  /** Durable memory data directory for item-count stats. */
  durableDataDir: string;
  /** Whether durable memory is enabled. */
  durableMemoryEnabled: boolean;
  /** Active cron scheduler; null until cron subsystem initializes. */
  cronScheduler: CronScheduler | null;
  /** Shared task store for open-task count. */
  sharedTaskStore: TaskStore | null;
  /** Set of runtime provider IDs that are actively configured (e.g. 'claude', 'openai'). */
  activeProviders?: Set<string>;
};

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
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  paFilePaths: Array<{ label: string; path: string }>;
  /** Timeout for live API connectivity checks (ms). Defaults to 5 000 ms. */
  apiCheckTimeoutMs?: number;
  /** Set of runtime provider IDs that are actively configured. */
  activeProviders?: Set<string>;
};

/**
 * Race an API credential check against a timeout sentinel.
 * Returns a 'fail' result if the check doesn't resolve within `timeoutMs`.
 */
function withApiTimeout(
  promise: Promise<CredentialCheckResult>,
  timeoutMs: number,
  name: string,
): Promise<CredentialCheckResult> {
  const timeout = new Promise<CredentialCheckResult>((resolve) => {
    const t = setTimeout(
      () => resolve({ name, status: 'fail', message: `check timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    // Don't block the Node.js event loop exit while this timer is pending.
    t.unref?.();
  });
  return Promise.race([promise, timeout]);
}

async function countDurableItems(dir: string): Promise<number> {
  let total = 0;
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        total += parseActiveDurableItems(JSON.parse(raw) as unknown);
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
        total += parseSummaryLength(JSON.parse(raw) as unknown);
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
        await fs.stat(filePath);
        return { label, exists: true };
      } catch {
        return { label, exists: false };
      }
    }),
  );
}

export async function collectStatusSnapshot(opts: CollectStatusOpts): Promise<StatusSnapshot> {
  const now = Date.now();
  const apiCheckTimeoutMs = opts.apiCheckTimeoutMs ?? DEFAULT_API_CHECK_TIMEOUT_MS;

  const [durableItemCount, rollingSummaryCharCount, apiChecks, paFiles] = await Promise.all([
    opts.durableDataDir ? countDurableItems(opts.durableDataDir) : Promise.resolve(0),
    opts.summaryDataDir ? countRollingSummaryChars(opts.summaryDataDir) : Promise.resolve(0),
    (async () => {
      const checks: Promise<CredentialCheckResult>[] = [
        withApiTimeout(checkDiscordToken(opts.discordToken), apiCheckTimeoutMs, 'discord-token'),
      ];
      const runOpenAi = opts.activeProviders === undefined || opts.activeProviders.has('openai');
      if (runOpenAi) {
        checks.push(
          withApiTimeout(
            checkOpenAiKey({ apiKey: opts.openaiApiKey, baseUrl: opts.openaiBaseUrl }),
            apiCheckTimeoutMs,
            'openai-key',
          ),
        );
      }
      const runOpenRouter = opts.activeProviders !== undefined && opts.activeProviders.has('openrouter');
      if (runOpenRouter) {
        checks.push(
          withApiTimeout(
            checkOpenRouterKey({ apiKey: opts.openrouterApiKey, baseUrl: opts.openrouterBaseUrl }),
            apiCheckTimeoutMs,
            'openrouter-key',
          ),
        );
      }
      return Promise.all(checks);
    })(),
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
