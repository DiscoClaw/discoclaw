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
];

/**
 * Ensure workspace PA template files exist. Copies any missing files from
 * `templates/workspace/` to the workspace directory. Never overwrites existing files.
 *
 * @returns list of files that were newly created (empty if workspace was already set up)
 */
export async function ensureWorkspaceBootstrapFiles(
  workspaceCwd: string,
  log?: { info: (obj: Record<string, unknown>, msg: string) => void },
): Promise<string[]> {
  const templatesDir = path.join(__dirname, '..', 'templates', 'workspace');
  await fs.mkdir(workspaceCwd, { recursive: true });

  const created: string[] = [];
  for (const file of TEMPLATE_FILES) {
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

  if (created.length > 0) {
    log?.info({ created, workspaceCwd }, 'workspace:bootstrap scaffolded PA files');
  }

  return created;
}
