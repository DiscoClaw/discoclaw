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

// ---------------------------------------------------------------------------
// bd CLI wrappers
// ---------------------------------------------------------------------------

async function runBd(args: string[], cwd: string): Promise<string> {
  const result = await execa(BD_BIN, args, { cwd, reject: false });
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
