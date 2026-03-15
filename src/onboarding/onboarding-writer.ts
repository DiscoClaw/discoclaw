/**
 * Onboarding writer — generates workspace files from collected onboarding values.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { OnboardingValues } from './onboarding-flow.js';
import { isOnboardingComplete } from '../workspace-bootstrap.js';

export interface WriteResult {
  written: string[];
  errors: string[];
  warnings: string[];
}

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

/**
 * Generate IDENTITY.md content using the default bot name "Discoclaw".
 * No template markers — ensures isOnboardingComplete() returns true.
 */
function generateIdentityContent(): string {
  return [
    `# IDENTITY.md - Who Am I?`,
    ``,
    `- **Name:** Discoclaw`,
    `- **Creature:** Familiar — a persistent presence that lives in the tools, remembers the work, and shows up ready.`,
    `- **Vibe:** Direct, competent, dry. Concise when the moment calls for it, thorough when it matters.`,
    `- **Emoji:** None`,
    ``,
    `---`,
    ``,
    `This isn't just metadata. It's the start of figuring out who you are.`,
  ].join('\n') + '\n';
}

/**
 * Generate USER.md content from onboarding values.
 */
function generateUserContent(values: OnboardingValues): string {
  return [
    `# USER.md - About Your Human`,
    ``,
    `- **Name:** ${values.userName}`,
    `- **What to call them:** ${values.userName}`,
    `- **Timezone:** ${values.timezone}`,
    `- **Morning check-in:** ${values.morningCheckin ? 'Yes' : 'No'}`,
    ``,
    `---`,
    ``,
    `The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.`,
  ].join('\n') + '\n';
}

/**
 * Write IDENTITY.md and USER.md from onboarding values.
 * Always writes both files. On retry, overwrites any previously-written file.
 */
export async function writeWorkspaceFiles(
  values: OnboardingValues,
  workspaceCwd: string,
): Promise<WriteResult> {
  const result: WriteResult = { written: [], errors: [], warnings: [] };

  // Generate IDENTITY.md
  const identityContent = generateIdentityContent();
  const identityPath = path.join(workspaceCwd, 'IDENTITY.md');
  try {
    await fs.writeFile(identityPath, identityContent, 'utf-8');
    result.written.push('IDENTITY.md');
  } catch (err) {
    result.errors.push(`Failed to write IDENTITY.md: ${(err as Error).message}`);
  }

  // Generate USER.md
  const userContent = generateUserContent(values);
  const userPath = path.join(workspaceCwd, 'USER.md');
  try {
    await fs.writeFile(userPath, userContent, 'utf-8');
    result.written.push('USER.md');
  } catch (err) {
    result.errors.push(`Failed to write USER.md: ${(err as Error).message}`);
  }

  // Check for unresolved placeholders in written files
  for (const file of result.written) {
    try {
      const content = await fs.readFile(path.join(workspaceCwd, file), 'utf-8');
      const remaining = content.match(PLACEHOLDER_RE);
      if (remaining) {
        result.warnings.push(
          `${file} has unresolved placeholders: ${remaining.join(', ')}. You can edit them manually later.`,
        );
      }
    } catch {
      // File was written but can't be read back — unusual but not critical.
    }
  }

  // Post-write validation
  if (result.errors.length === 0) {
    const complete = await isOnboardingComplete(workspaceCwd);
    if (!complete) {
      result.errors.push('Post-write validation failed: isOnboardingComplete() returned false.');
    } else {
      // Clean up first-run instructions now that onboarding is done.
      const bootstrapPath = path.join(workspaceCwd, 'BOOTSTRAP.md');
      try {
        await fs.unlink(bootstrapPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Failed to clean up BOOTSTRAP.md: ${(err as Error).message}`);
        }
      }
    }
  }

  return result;
}
