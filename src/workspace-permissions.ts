import fs from 'node:fs/promises';
import path from 'node:path';
import { KNOWN_TOOLS } from './config.js';

export type PermissionTier = 'readonly' | 'standard' | 'full' | 'custom';

export type WorkspacePermissions = {
  tier: PermissionTier;
  tools?: string[];
  note?: string;
};

const VALID_TIERS: ReadonlySet<string> = new Set(['readonly', 'standard', 'full', 'custom']);

export const MAX_NOTE_LENGTH = 500;

export const TIER_TOOLS: Record<Exclude<PermissionTier, 'custom'>, string[]> = {
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  standard: ['Read', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  full: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Pipeline', 'Step'],
};

type LogFn = { warn?: (obj: Record<string, unknown>, msg: string) => void };

function validatedNote(
  obj: Record<string, unknown>,
  filePath: string,
  log?: LogFn,
): { note: string } | Record<string, never> {
  if (typeof obj.note !== 'string') return {};
  if (obj.note.length > MAX_NOTE_LENGTH) {
    log?.warn?.({ filePath, length: obj.note.length, max: MAX_NOTE_LENGTH },
      'workspace-permissions: note exceeds max length, ignoring');
    return {};
  }
  return { note: obj.note };
}

/**
 * Load and validate workspace/PERMISSIONS.json. Returns null if the file
 * doesn't exist or is invalid (with a warning logged for invalid files).
 */
export async function loadWorkspacePermissions(
  workspaceCwd: string,
  log?: LogFn,
): Promise<WorkspacePermissions | null> {
  const filePath = path.join(workspaceCwd, 'PERMISSIONS.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null; // File doesn't exist — use fallback.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.warn?.({ filePath }, 'workspace-permissions: invalid JSON, ignoring');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log?.warn?.({ filePath }, 'workspace-permissions: expected object, ignoring');
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.tier !== 'string' || !VALID_TIERS.has(obj.tier)) {
    log?.warn?.({ filePath, tier: obj.tier }, 'workspace-permissions: invalid tier, ignoring');
    return null;
  }

  const tier = obj.tier as PermissionTier;

  if (tier === 'custom') {
    if (!Array.isArray(obj.tools) || !obj.tools.every((t) => typeof t === 'string')) {
      log?.warn?.({ filePath }, 'workspace-permissions: custom tier requires tools array, ignoring');
      return null;
    }
    const tools = obj.tools as string[];
    if (tools.length === 0) {
      log?.warn?.({ filePath }, 'workspace-permissions: custom tier has empty tools array');
    }
    const unknown = tools.filter((t) => !KNOWN_TOOLS.has(t));
    if (unknown.length) {
      log?.warn?.({ filePath, unknown }, 'workspace-permissions: unknown tool names');
    }
    return {
      tier,
      tools,
      ...validatedNote(obj, filePath, log),
    };
  }

  return {
    tier,
    ...validatedNote(obj, filePath, log),
  };
}

export type PermissionProbeResult =
  | { status: 'valid'; permissions: WorkspacePermissions }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/**
 * Probe workspace/PERMISSIONS.json and return a discriminated result
 * indicating whether the file is valid, missing, or invalid (with reason).
 */
export async function probeWorkspacePermissions(
  workspaceCwd: string,
): Promise<PermissionProbeResult> {
  const filePath = path.join(workspaceCwd, 'PERMISSIONS.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { status: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'invalid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', reason: 'expected object' };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.tier !== 'string' || !VALID_TIERS.has(obj.tier)) {
    return { status: 'invalid', reason: `invalid tier: ${JSON.stringify(obj.tier)}` };
  }

  const tier = obj.tier as PermissionTier;

  if (tier === 'custom') {
    if (!Array.isArray(obj.tools) || !obj.tools.every((t) => typeof t === 'string')) {
      return { status: 'invalid', reason: 'custom tier requires tools array' };
    }
    return {
      status: 'valid',
      permissions: {
        tier,
        tools: obj.tools as string[],
        ...validatedNote(obj, filePath),
      },
    };
  }

  return {
    status: 'valid',
    permissions: {
      tier,
      ...validatedNote(obj, filePath),
    },
  };
}

/**
 * Resolve the effective tools array. Workspace permissions take precedence
 * over the env-var-based tools list.
 */
export function resolveTools(
  permissions: WorkspacePermissions | null,
  envTools: string[],
): string[] {
  if (!permissions) return envTools;
  const envSet = new Set(envTools);
  const upperBound = permissions.tier === 'custom'
    ? (permissions.tools ?? envTools)
    : TIER_TOOLS[permissions.tier];
  return upperBound.filter((tool) => envSet.has(tool));
}
