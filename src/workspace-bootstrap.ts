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
 * contains the template placeholder text. Once complete, BOOTSTRAP.md
 * is no longer scaffolded and any stale copy is auto-deleted.
 */
export async function isOnboardingComplete(workspaceCwd: string): Promise<boolean> {
  const identityPath = path.join(workspaceCwd, 'IDENTITY.md');
  try {
    const content = await fs.readFile(identityPath, 'utf-8');
    // The template IDENTITY.md contains placeholder prompts like
    // "*(pick something you like)*". If those are still present, the agent
    // hasn't completed onboarding yet. If they're gone, someone filled it in.
    return !content.includes(IDENTITY_TEMPLATE_MARKER);
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
  log?: { info: (obj: Record<string, unknown>, msg: string) => void },
): Promise<string[]> {
  const templatesDir = path.join(__dirname, '..', 'templates', 'workspace');
  await fs.mkdir(workspaceCwd, { recursive: true });

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
      created.push(file);
    }
  }

  // Auto-delete stale BOOTSTRAP.md after onboarding.
  if (onboarded) {
    const bootstrapPath = path.join(workspaceCwd, 'BOOTSTRAP.md');
    try {
      await fs.unlink(bootstrapPath);
      log?.info({ workspaceCwd }, 'workspace:bootstrap auto-deleted stale BOOTSTRAP.md');
    } catch {
      // Already gone — nothing to do.
    }
  }

  // Ensure the daily log directory exists for file-based memory.
  await fs.mkdir(path.join(workspaceCwd, 'memory'), { recursive: true });

  if (created.length > 0) {
    log?.info({ created, workspaceCwd }, 'workspace:bootstrap scaffolded PA files');
  }

  return created;
}
