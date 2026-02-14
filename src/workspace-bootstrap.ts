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
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
];

/** Marker text present in the template IDENTITY.md but removed during onboarding. */
const IDENTITY_TEMPLATE_MARKER = '*(pick something you like)*';

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
 * `templates/workspace/` to the workspace directory. Never overwrites existing files.
 *
 * When onboarding is complete (IDENTITY.md has real content), BOOTSTRAP.md is
 * excluded from scaffolding and any existing copy is auto-deleted to prevent
 * wasted context tokens and confusing first-run instructions.
 *
 * @returns list of files that were newly created (empty if workspace was already set up)
 */
export async function ensureWorkspaceBootstrapFiles(
  workspaceCwd: string,
  log?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  },
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
    try {
      await fs.access(dest);
      // File already exists — don't overwrite.
    } catch {
      const src = path.join(templatesDir, file);
      await fs.copyFile(src, dest);
      // Inject the system timezone into USER.md for new workspaces.
      if (file === 'USER.md') {
        const content = await fs.readFile(dest, 'utf-8');
        const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await fs.writeFile(dest, content.replace('- **Timezone:**', `- **Timezone:** ${systemTz}`), 'utf-8');
      }
      created.push(file);
    }
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

  if (created.length > 0) {
    log?.info({ created, workspaceCwd }, 'workspace:bootstrap scaffolded PA files');
  }

  return created;
}
