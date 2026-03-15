import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Files scaffolded from templates/workspace/ into the workspace on first run. */
const TEMPLATE_FILES = [
  'BOOTSTRAP.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'MEMORY.md',
];

/**
 * Marker strings from the legacy AGENTS.md template where system-owned
 * instructions lived in workspace files before runtime-injected defaults.
 */
const LEGACY_AGENTS_MARKERS = [
  '## Rebuild & Restart Workflow',
  '## Releasing to npm',
  '## Discord Action Batching',
  '## Forge, Plan & Memory Action Types',
  '## Bead Creation',
  '## YouTube Links',
  '## Codex working directory',
];
const LEGACY_AGENTS_MIN_MARKER_HITS = 2;

/** Marker text present in the template IDENTITY.md but removed during onboarding. */
const IDENTITY_TEMPLATE_MARKER = '*(pick something you like)*';

/**
 * Stale TOOLS.md markers: the old full action-type reference that has been
 * replaced by a pointer stub. Both markers must be present to trigger migration.
 */
const STALE_TOOLS_MARKER_HEADING = '## Discord Action Types';
const STALE_TOOLS_MARKER_SUBHEADING = '### Forge Actions';

const LEGACY_AGENTS_WARNING_MESSAGE =
  'legacy AGENTS.md system sections detected — this can conflict with runtime default instructions.';
const LEGACY_AGENTS_WARNING_RECOMMENDATION =
  'Keep personal rules in AGENTS.md and remove migrated system sections.';
const LEGACY_DISCOCLAW_WARNING_MESSAGE =
  'legacy DISCOCLAW.md detected — file is no longer managed and was left untouched.';
const LEGACY_DISCOCLAW_WARNING_RECOMMENDATION =
  'Default instructions are injected at runtime; keep user overrides in AGENTS.md.';
const LEGACY_TOOLS_WARNING_MESSAGE =
  'legacy TOOLS.md system sections detected — file is user-owned and was left untouched.';
const LEGACY_TOOLS_WARNING_RECOMMENDATION =
  'If this is an unmodified scaffold copy, delete or replace it manually so tracked TOOLS.md can be the primary source.';

type BootstrapLog = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export type WorkspaceBootstrapWarning = {
  id: 'workspace-bootstrap:legacy-agents-system-sections' | 'workspace-bootstrap:legacy-discoclaw' | 'workspace-bootstrap:legacy-tools-system-sections';
  file: 'AGENTS.md' | 'DISCOCLAW.md' | 'TOOLS.md';
  message: string;
  recommendation: string;
  matchedMarkers?: string[];
};

function findLegacyAgentsMarkers(content: string): string[] {
  return LEGACY_AGENTS_MARKERS.filter((marker) => content.includes(marker));
}

export function inspectWorkspaceBootstrapWarningsSync(workspaceCwd: string): WorkspaceBootstrapWarning[] {
  const warnings: WorkspaceBootstrapWarning[] = [];

  const legacyDiscoclawPath = path.join(workspaceCwd, 'DISCOCLAW.md');
  if (existsSync(legacyDiscoclawPath)) {
    warnings.push({
      id: 'workspace-bootstrap:legacy-discoclaw',
      file: 'DISCOCLAW.md',
      message: LEGACY_DISCOCLAW_WARNING_MESSAGE,
      recommendation: LEGACY_DISCOCLAW_WARNING_RECOMMENDATION,
    });
  }

  const agentsPath = path.join(workspaceCwd, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    try {
      const content = readFileSync(agentsPath, 'utf-8');
      const matchedMarkers = findLegacyAgentsMarkers(content);
      if (matchedMarkers.length >= LEGACY_AGENTS_MIN_MARKER_HITS) {
        warnings.push({
          id: 'workspace-bootstrap:legacy-agents-system-sections',
          file: 'AGENTS.md',
          message: LEGACY_AGENTS_WARNING_MESSAGE,
          recommendation: LEGACY_AGENTS_WARNING_RECOMMENDATION,
          matchedMarkers,
        });
      }
    } catch {
      // Ignore sync inspection read failures; bootstrap startup uses the async path.
    }
  }

  const toolsPath = path.join(workspaceCwd, 'TOOLS.md');
  if (existsSync(toolsPath)) {
    try {
      const content = readFileSync(toolsPath, 'utf-8');
      if (content.includes(STALE_TOOLS_MARKER_HEADING) && content.includes(STALE_TOOLS_MARKER_SUBHEADING)) {
        warnings.push({
          id: 'workspace-bootstrap:legacy-tools-system-sections',
          file: 'TOOLS.md',
          message: LEGACY_TOOLS_WARNING_MESSAGE,
          recommendation: LEGACY_TOOLS_WARNING_RECOMMENDATION,
        });
      }
    } catch {
      // Ignore sync inspection read failures; bootstrap startup uses the async path.
    }
  }

  return warnings;
}

async function warnIfLegacyAgentsContainsSystemInstructions(
  workspaceCwd: string,
  log?: BootstrapLog,
): Promise<void> {
  const agentsPath = path.join(workspaceCwd, 'AGENTS.md');
  let content = '';
  try {
    content = await fs.readFile(agentsPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const matchedMarkers = findLegacyAgentsMarkers(content);
  if (matchedMarkers.length < LEGACY_AGENTS_MIN_MARKER_HITS) return;

  log?.warn(
    { workspaceCwd, matchedMarkers },
    `workspace:bootstrap ${LEGACY_AGENTS_WARNING_MESSAGE} ${LEGACY_AGENTS_WARNING_RECOMMENDATION}`,
  );
}

async function warnIfLegacyDiscoclawPresent(workspaceCwd: string, log?: BootstrapLog): Promise<void> {
  const legacyDiscoclawPath = path.join(workspaceCwd, 'DISCOCLAW.md');
  try {
    await fs.access(legacyDiscoclawPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  log?.warn(
    { workspaceCwd, file: 'DISCOCLAW.md' },
    `workspace:bootstrap ${LEGACY_DISCOCLAW_WARNING_MESSAGE} ${LEGACY_DISCOCLAW_WARNING_RECOMMENDATION}`,
  );
}

/**
 * Detect a legacy workspace TOOLS.md that still contains old system-owned
 * sections. The file is user-owned, so we warn but never rewrite it.
 */
async function warnIfLegacyToolsContainsSystemInstructions(
  workspaceCwd: string,
  log?: BootstrapLog,
): Promise<void> {
  const toolsPath = path.join(workspaceCwd, 'TOOLS.md');
  let content = '';
  try {
    content = await fs.readFile(toolsPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  // Warn only when both markers are present — specific enough to catch legacy
  // scaffold copies without rewriting a user-owned override file.
  if (!content.includes(STALE_TOOLS_MARKER_HEADING) || !content.includes(STALE_TOOLS_MARKER_SUBHEADING)) return;

  log?.warn(
    { workspaceCwd, file: 'TOOLS.md' },
    `workspace:bootstrap ${LEGACY_TOOLS_WARNING_MESSAGE} ${LEGACY_TOOLS_WARNING_RECOMMENDATION}`,
  );
}

/**
 * Onboarding is considered complete when IDENTITY.md exists and no longer
 * contains the template placeholder text. USER.md is NOT checked because
 * it's designed to be incrementally filled in — existing installs may have
 * a populated USER.md that still contains the template intro line, and
 * flagging that as "not onboarded" would force re-onboarding and overwrite
 * user-authored content.
 *
 * Once complete, BOOTSTRAP.md is no longer scaffolded and any stale copy is auto-deleted.
 */
export async function isOnboardingComplete(workspaceCwd: string): Promise<boolean> {
  const identityPath = path.join(workspaceCwd, 'IDENTITY.md');
  try {
    const content = await fs.readFile(identityPath, 'utf-8');
    if (content.includes(IDENTITY_TEMPLATE_MARKER)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure workspace PA template files exist. Copies any missing files from
 * `templates/workspace/` to the workspace directory. Never overwrites existing
 * user-owned files.
 *
 * Compatibility note: legacy workspace/DISCOCLAW.md files are left untouched.
 * Managed defaults now come from runtime-injected tracked instructions.
 *
 * When onboarding is complete (IDENTITY.md has real content), BOOTSTRAP.md is
 * excluded from scaffolding and any existing copy is auto-deleted to prevent
 * wasted context tokens and confusing first-run instructions.
 *
 * @returns list of files that were newly created (empty if workspace was already set up)
 */
export async function ensureWorkspaceBootstrapFiles(
  workspaceCwd: string,
  log?: BootstrapLog,
): Promise<string[]> {
  const templatesDir = path.join(__dirname, '..', 'templates', 'workspace');
  await fs.mkdir(workspaceCwd, { recursive: true });

  const forceBootstrap = process.env.DISCOCLAW_FORCE_BOOTSTRAP === '1';

  if (forceBootstrap) {
    log?.warn(
      { workspaceCwd },
      'workspace:bootstrap DISCOCLAW_FORCE_BOOTSTRAP=1 is active — BOOTSTRAP.md will be forcibly (re)created from template. ' +
        'This env var is for one-shot use; unset it after this restart.',
    );
  }

  const onboarded = await isOnboardingComplete(workspaceCwd);

  const created: string[] = [];
  for (const file of TEMPLATE_FILES) {
    // Skip BOOTSTRAP.md entirely once onboarding is complete.
    if (file === 'BOOTSTRAP.md' && onboarded) continue;

    const dest = path.join(workspaceCwd, file);

    let fileExists = false;
    try {
      await fs.access(dest);
      fileExists = true;
    } catch {
      // File doesn't exist — will be created below.
    }

    // Never overwrite existing user-owned files.
    if (fileExists) continue;

    const src = path.join(templatesDir, file);
    await fs.copyFile(src, dest);

    // Inject the system timezone into USER.md for new workspaces.
    if (file === 'USER.md') {
      const content = await fs.readFile(dest, 'utf-8');
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await fs.writeFile(dest, content.replace('- **Timezone:**', `- **Timezone:** ${systemTz}`), 'utf-8');
    }

    created.push(file);
    log?.info({ file, workspaceCwd }, 'workspace:bootstrap recreated missing file');
  }

  // BOOTSTRAP.md-specific post-loop logic.
  if (forceBootstrap) {
    // Force path: delete existing BOOTSTRAP.md (if any), then copy from template.
    const bootstrapDest = path.join(workspaceCwd, 'BOOTSTRAP.md');
    try {
      await fs.unlink(bootstrapDest);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const templateBootstrapPath = path.join(templatesDir, 'BOOTSTRAP.md');
    await fs.copyFile(templateBootstrapPath, bootstrapDest);
    log?.info({ workspaceCwd }, 'workspace:bootstrap BOOTSTRAP.md force-created from template');
  } else if (onboarded) {
    // Normal onboarded path: warn about stale file, then auto-delete.
    const bootstrapPath = path.join(workspaceCwd, 'BOOTSTRAP.md');
    let bootstrapExists = false;
    try {
      await fs.access(bootstrapPath);
      bootstrapExists = true;
    } catch {
      // File doesn't exist — nothing to clean up.
    }
    if (bootstrapExists) {
      log?.warn(
        { workspaceCwd },
        'workspace:bootstrap stale BOOTSTRAP.md found in onboarded workspace — auto-deleting. ' +
          'If this recurs on every restart, check for external automation or macOS app conflicts ' +
          'that may be re-creating the file.',
      );
      try {
        await fs.unlink(bootstrapPath);
        log?.info({ workspaceCwd }, 'workspace:bootstrap auto-deleted stale BOOTSTRAP.md');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Race: another process deleted it between access and unlink.
          log?.info({ workspaceCwd }, 'workspace:bootstrap stale BOOTSTRAP.md already deleted by another process');
        } else {
          log?.warn(
            { workspaceCwd, error: (err as Error).message },
            'workspace:bootstrap failed to auto-delete stale BOOTSTRAP.md — check file permissions',
          );
          throw err;
        }
      }
    }
  }

  // Ensure the daily log directory exists for file-based memory.
  await fs.mkdir(path.join(workspaceCwd, 'memory'), { recursive: true });

  await warnIfLegacyDiscoclawPresent(workspaceCwd, log);
  await warnIfLegacyAgentsContainsSystemInstructions(workspaceCwd, log);

  // One-time TOOLS.md compatibility check: warn about legacy system-owned content.
  await warnIfLegacyToolsContainsSystemInstructions(workspaceCwd, log);

  if (created.length > 0) {
    log?.info({ created, workspaceCwd }, 'workspace:bootstrap scaffolded PA files');
  }

  return created;
}
