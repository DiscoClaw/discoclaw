import fs from 'node:fs/promises';
import path from 'node:path';

export async function parseIdentityName(workspaceCwd: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(workspaceCwd, 'IDENTITY.md'), 'utf8');
    const patterns = [
      /^-\s*\*\*Name:\*\*\s*(.+)$/m,      // - **Name:** Weston
      /^\*\*Name\*\*:\s*(.+)$/m,            // **Name**: Weston
      /^Name:\s*(.+)$/mi,                   // Name: Weston
    ];
    for (const re of patterns) {
      const match = raw.match(re);
      if (match?.[1]?.trim()) return match[1].trim();
    }
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
