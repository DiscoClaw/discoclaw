/**
 * Onboarding writer — reads templates, substitutes placeholders, writes files.
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
 * Build substitution map from collected onboarding values.
 * Placeholders not covered by the values get sensible defaults.
 */
function buildPlaceholders(values: OnboardingValues): Record<string, string> {
  const purposeLabel =
    values.purpose === 'dev' ? 'Development / coding'
    : values.purpose === 'pa' ? 'Personal assistant'
    : 'Development + personal assistant';

  return {
    '{{BOT_NAME}}': values.botName,
    '{{USER_NAME}}': values.userName,
    '{{PURPOSE}}': purposeLabel,
    '{{WORKING_DIRS}}': values.workingDirs || '(not specified)',
    '{{PERSONALITY}}': values.personality || 'Direct, competent, concise.',
    '{{CREATURE}}': 'Familiar — a persistent presence that lives in the tools, remembers the work, and shows up ready.',
    '{{VIBE}}': values.personality || 'Direct, competent, dry. Concise when the moment calls for it, thorough when it matters.',
    '{{EMOJI}}': 'None',
  };
}

/**
 * Generate IDENTITY.md content from values (not from template file).
 * This produces a clean, filled-in identity file without template markers.
 */
function generateIdentityContent(values: OnboardingValues, placeholders: Record<string, string>): string {
  return [
    `# IDENTITY.md - Who Am I?`,
    ``,
    `- **Name:** ${values.botName}`,
    `- **Creature:** ${placeholders['{{CREATURE}}']}`,
    `- **Vibe:** ${placeholders['{{VIBE}}']}`,
    `- **Emoji:** ${placeholders['{{EMOJI}}']}`,
    ``,
    `---`,
    ``,
    `This isn't just metadata. It's the start of figuring out who you are.`,
  ].join('\n') + '\n';
}

/**
 * Generate USER.md content from values.
 */
function generateUserContent(values: OnboardingValues): string {
  const sections: string[] = [
    `# USER.md - About Your Human`,
    ``,
    `- **Name:** ${values.userName}`,
    `- **What to call them:** ${values.userName}`,
  ];

  if (values.purpose === 'dev' || values.purpose === 'both') {
    sections.push(``);
    sections.push(`## Work`);
    if (values.workingDirs) {
      sections.push(`- **Working directories:** ${values.workingDirs}`);
    }
  }

  if (values.purpose === 'pa' || values.purpose === 'both') {
    sections.push(``);
    sections.push(`## Preferences`);
    if (values.personality) {
      sections.push(`- **Communication style:** ${values.personality}`);
    }
  }

  sections.push(``);
  sections.push(`---`);
  sections.push(``);
  sections.push(`The more you know, the better you can help. But remember — you're learning about a person, not building a dossier. Respect the difference.`);

  return sections.join('\n') + '\n';
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
  const placeholders = buildPlaceholders(values);

  // Generate IDENTITY.md
  const identityContent = generateIdentityContent(values, placeholders);
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
    }
  }

  return result;
}
