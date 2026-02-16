import path from 'node:path';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import type { BeadData, BeadCreateParams, BeadUpdateParams, BeadListParams } from './types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BD_BIN = process.env.BD_BIN || 'bd';

// ---------------------------------------------------------------------------
// Legacy status normalization
// ---------------------------------------------------------------------------

/** Map removed statuses to their replacement. */
const LEGACY_STATUS_MAP: Record<string, BeadData['status']> = {
  done: 'closed',
  tombstone: 'closed',
};

/** Normalize legacy bead statuses (`done`, `tombstone`) → `closed`. */
export function normalizeBeadData(bead: BeadData): BeadData {
  const mapped = LEGACY_STATUS_MAP[bead.status as string];
  if (mapped) return { ...bead, status: mapped };
  return bead;
}

// ---------------------------------------------------------------------------
// JSON parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse bd CLI JSON output. Handles:
 *   - Array output (list, show)
 *   - Single-object output (create)
 *   - Markdown-fenced JSON (```json ... ```)
 *   - Empty / error output
 */
export function parseBdJson<T = BeadData>(stdout: string): T[] {
  let text = stdout.trim();
  if (!text) return [];

  // Strip markdown fences if present.
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  text = text.trim();
  if (!text) return [];

  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && typeof parsed === 'object') {
    // bd returns { error: "..." } on failures.
    if ('error' in parsed && Object.keys(parsed).length === 1) {
      throw new Error(String(parsed.error));
    }
    return [parsed as T];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

/** Check whether the bd CLI binary is available. */
export async function checkBdAvailable(): Promise<{ available: boolean; version?: string }> {
  try {
    const result = await execa(BD_BIN, ['--version'], { reject: false });
    if (result.exitCode === 0) {
      return { available: true, version: result.stdout.trim() || undefined };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

/**
 * Verify the beads database at `cwd` is initialized with an issue_prefix.
 * Without a prefix, bd silently falls through to the global daemon registry
 * and may write to a completely different instance's database.
 *
 * If the prefix is missing, attempt to auto-set it from the data directory name.
 * Returns the detected prefix or null if the database cannot be reached.
 */
export async function ensureBdDatabaseReady(cwd: string): Promise<{ ready: boolean; prefix?: string }> {
  const dbPath = path.resolve(cwd, '.beads', 'beads.db');
  try {
    const result = await execa(BD_BIN, ['--db', dbPath, '--no-daemon', 'config', 'get', 'issue_prefix'], {
      cwd,
      reject: false,
    });
    const output = result.stdout.trim();
    // bd config get returns "key (not set)" when unset, or just the value when set.
    if (result.exitCode === 0 && output && !output.includes('(not set)')) {
      return { ready: true, prefix: output };
    }
    // Prefix not set — auto-initialize from directory name.
    // Resolve symlinks so that e.g. code/discoclaw/workspace → discoclaw-data/workspace
    // derives "data" from the real target, not "dc" from the symlink parent.
    const realCwd = await fs.realpath(cwd);
    const dirName = path.basename(path.resolve(realCwd, '..'));
    // Derive a short prefix: "discoclaw-personal" → "personal", "discoclaw-data" → "data", fallback to "dc"
    const prefix = dirName.replace(/^discoclaw-?/, '').replace(/[^a-z0-9]/gi, '') || 'dc';
    const setResult = await execa(BD_BIN, ['--db', dbPath, '--no-daemon', 'config', 'set', 'issue_prefix', prefix], {
      cwd,
      reject: false,
    });
    if (setResult.exitCode === 0) {
      return { ready: true, prefix };
    }
    return { ready: false };
  } catch {
    return { ready: false };
  }
}

// ---------------------------------------------------------------------------
// bd CLI wrappers
// ---------------------------------------------------------------------------

async function runBd(args: string[], cwd: string): Promise<string> {
  // Pin bd to the exact database for this workspace. Without this, bd's
  // auto-discovery walks up parent directories and may connect to a daemon
  // belonging to a different discoclaw instance (e.g. dev vs personal).
  const dbPath = path.resolve(cwd, '.beads', 'beads.db');
  const pinnedArgs = ['--db', dbPath, '--no-daemon', ...args];
  const result = await execa(BD_BIN, pinnedArgs, { cwd, reject: false });
  if (result.exitCode !== 0) {
    // Try to extract a structured error from JSON output.
    const out = (result.stdout ?? '').trim();
    if (out) {
      try {
        const parsed = JSON.parse(out);
        if (parsed?.error) throw new Error(String(parsed.error));
      } catch (e) {
        if (e instanceof SyntaxError) {
          // Not JSON — fall through.
        } else {
          throw e;
        }
      }
    }
    const errText = (result.stderr ?? '').trim() || out || `bd exited with code ${result.exitCode}`;
    throw new Error(errText);
  }
  return result.stdout;
}

/** Show a single bead by ID. Returns null if not found. */
export async function bdShow(id: string, cwd: string): Promise<BeadData | null> {
  try {
    const stdout = await runBd(['show', '--json', id], cwd);
    const items = parseBdJson<BeadData>(stdout);
    return items[0] ? normalizeBeadData(items[0]) : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Known "not found" variants from the bd CLI:
    //   - "not found" (standard)
    //   - "no issue found matching" (resolve-by-prefix failure)
    if (/not found|no issue found/i.test(msg)) return null;
    throw err;
  }
}

/** List beads matching the given filters. */
export async function bdList(params: BeadListParams, cwd: string): Promise<BeadData[]> {
  const args = ['list', '--json'];
  if (params.status === 'all') {
    args.push('--all');
  } else if (params.status) {
    args.push('--status', params.status);
  }
  if (params.label) args.push('--label', params.label);
  if (params.limit) args.push('--limit', String(params.limit));

  const stdout = await runBd(args, cwd);
  const items = parseBdJson<BeadData>(stdout);

  return items.map(normalizeBeadData);
}

/**
 * Find a non-closed bead whose title matches the given string
 * (case-insensitive, trimmed). Optionally filter by label.
 * Returns the first match, or null if none found.
 */
export async function bdFindByTitle(
  title: string,
  cwd: string,
  opts?: { label?: string },
): Promise<BeadData | null> {
  const normalizedTitle = title.trim().toLowerCase();
  if (!normalizedTitle) return null;

  const beads = await bdList(opts?.label ? { label: opts.label } : {}, cwd);
  const match = beads.find(
    (b) => b.status !== 'closed' && b.title.trim().toLowerCase() === normalizedTitle,
  );
  return match ?? null;
}

/** Create a new bead. Returns the created bead data. */
export async function bdCreate(params: BeadCreateParams, cwd: string): Promise<BeadData> {
  const args = ['create', '--json', params.title];
  if (params.description) args.push('--description', params.description);
  if (params.priority != null) args.push('--priority', String(params.priority));
  if (params.issueType) args.push('--type', params.issueType);
  if (params.owner) args.push('--assignee', params.owner);
  if (params.labels?.length) args.push('--labels', params.labels.join(','));

  const stdout = await runBd(args, cwd);
  const items = parseBdJson<BeadData>(stdout);
  if (!items[0]) throw new Error('bd create returned no data');
  return items[0];
}

/** Update a bead's fields. */
export async function bdUpdate(id: string, params: BeadUpdateParams, cwd: string): Promise<void> {
  const args = ['update', id];
  if (params.title) args.push('--title', params.title);
  if (params.description) args.push('--description', params.description);
  if (params.priority != null) args.push('--priority', String(params.priority));
  if (params.status) args.push('--status', params.status);
  if (params.owner) args.push('--assignee', params.owner);
  if (params.externalRef) args.push('--external-ref', params.externalRef);

  await runBd(args, cwd);
}

/** Close a bead. */
export async function bdClose(id: string, reason: string | undefined, cwd: string): Promise<void> {
  const args = ['close', id];
  if (reason) args.push('--reason', reason);
  await runBd(args, cwd);
}

/** Add a label to a bead. */
export async function bdAddLabel(id: string, label: string, cwd: string): Promise<void> {
  await runBd(['label', 'add', id, label], cwd);
}
