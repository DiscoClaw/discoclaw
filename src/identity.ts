import fs from 'node:fs/promises';
import path from 'node:path';

const DISCORD_NICKNAME_LIMIT = 32;
const DEFAULT_NAME = 'Discoclaw';

export type ResolveDisplayNameOpts = {
  configName?: string;
  workspaceCwd: string;
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
};

export async function resolveDisplayName(opts: ResolveDisplayNameOpts): Promise<string> {
  let name = opts.configName ?? await parseIdentityName(opts.workspaceCwd) ?? DEFAULT_NAME;
  if (name.length > DISCORD_NICKNAME_LIMIT) {
    opts.log?.warn(
      { original: name, truncated: name.slice(0, DISCORD_NICKNAME_LIMIT) },
      'botDisplayName exceeds Discord 32-char nickname limit; truncating',
    );
    name = name.slice(0, DISCORD_NICKNAME_LIMIT);
  }
  if (!name.trim()) {
    name = DEFAULT_NAME;
  }
  return name;
}

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
