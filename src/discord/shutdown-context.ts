import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShutdownReason = 'restart-command' | 'deploy' | 'code-fix' | 'unknown';

export type ShutdownContext = {
  reason: ShutdownReason;
  message?: string;
  timestamp: string;
  activeForge?: string;
  requestedBy?: string;
};

export type StartupContext = {
  type: 'intentional' | 'graceful-unknown' | 'crash' | 'first-boot';
  shutdown?: ShutdownContext;
};

const FILENAME = 'shutdown-context.json';
const VALID_REASONS = new Set<ShutdownReason>(['restart-command', 'deploy', 'code-fix', 'unknown']);
const MAX_FIELD_LENGTH = 500;

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Write (shutdown side)
// ---------------------------------------------------------------------------

/**
 * Write shutdown context atomically (tmp + rename).
 * If `skipIfExists` is true, preserves any richer context already written
 * (e.g., by !restart before the SIGTERM handler fires).
 */
export async function writeShutdownContext(
  dataDir: string,
  ctx: ShutdownContext,
  opts?: { skipIfExists?: boolean },
): Promise<void> {
  const filePath = path.join(dataDir, FILENAME);

  if (opts?.skipIfExists) {
    try {
      await fs.access(filePath);
      return; // File already exists — don't overwrite.
    } catch {
      // File doesn't exist — proceed with write.
    }
  }

  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(ctx) + '\n', 'utf-8');
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Read + clear (startup side)
// ---------------------------------------------------------------------------

/**
 * Read and delete the shutdown context file. Returns startup classification.
 * Pass `firstBoot: true` when the data directory was freshly created (no prior run)
 * to avoid a false "crash" warning on first-ever boot.
 */
export async function readAndClearShutdownContext(
  dataDir: string,
  opts?: { firstBoot?: boolean },
): Promise<StartupContext> {
  const filePath = path.join(dataDir, FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    // No file → crash unless this is the first-ever boot.
    return { type: opts?.firstBoot ? 'first-boot' : 'crash' };
  }

  // Delete the file regardless of parse outcome.
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort deletion.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted file → treat as crash.
    return { type: 'crash' };
  }

  // Non-object JSON (null, string, array, number) → treat as crash.
  const parsedObj = asObjectRecord(parsed);
  if (!parsedObj) {
    return { type: 'crash' };
  }

  // Validate reason against known union; unknown/missing → graceful-unknown.
  const reasonValue = parsedObj.reason;
  const reason: ShutdownReason = typeof reasonValue === 'string' && VALID_REASONS.has(reasonValue as ShutdownReason)
    ? (reasonValue as ShutdownReason)
    : 'unknown';
  const ctx: ShutdownContext = {
    reason,
    timestamp: typeof parsedObj.timestamp === 'string' ? parsedObj.timestamp : new Date().toISOString(),
    message: typeof parsedObj.message === 'string' ? parsedObj.message.slice(0, MAX_FIELD_LENGTH) : undefined,
    activeForge: typeof parsedObj.activeForge === 'string' ? parsedObj.activeForge.slice(0, MAX_FIELD_LENGTH) : undefined,
    requestedBy: typeof parsedObj.requestedBy === 'string' ? parsedObj.requestedBy : undefined,
  };

  if (ctx.reason === 'unknown') {
    return { type: 'graceful-unknown', shutdown: ctx };
  }

  return { type: 'intentional', shutdown: ctx };
}

// ---------------------------------------------------------------------------
// Format for AI injection
// ---------------------------------------------------------------------------

/**
 * Format startup context as a one-shot prompt injection string.
 * Returns null if there's nothing meaningful to inject (shouldn't happen
 * in practice, but defensive).
 */
export function formatStartupInjection(ctx: StartupContext): string | null {
  let line: string;

  switch (ctx.type) {
    case 'intentional': {
      const reason = ctx.shutdown?.reason ?? 'restart-command';
      const who = ctx.shutdown?.requestedBy
        ? ` by <@${ctx.shutdown.requestedBy}>`
        : '';
      const msg = ctx.shutdown?.message
        ? ` (${ctx.shutdown.message})`
        : '';
      const via = reason === 'restart-command' ? ' via !restart'
        : reason === 'deploy' ? ' for a deploy'
        : reason === 'code-fix' ? ' to apply a code fix'
        : '';
      line = `You were restarted${via}${who}${msg}.`;
      break;
    }
    case 'graceful-unknown':
      line = 'You were restarted (graceful shutdown, reason unknown — likely a manual systemctl restart).';
      break;
    case 'crash':
      line = 'You appear to have crashed or been killed (no shutdown context found). Consider checking journalctl logs.';
      break;
    case 'first-boot':
      return null; // Nothing to inject on first-ever boot.
    default:
      return null;
  }

  if (ctx.shutdown?.activeForge) {
    line += ` A forge run was in progress: ${ctx.shutdown.activeForge}.`;
  }

  line += ' If the current thread\'s task is already resolved, don\'t announce it — just respond to the user.';

  return line;
}
