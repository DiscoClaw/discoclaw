import fs from 'node:fs/promises';

// Valid env variable key: letter or underscore, followed by letters/digits/underscores.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SecretCommand =
  | { action: 'set'; key: string; value: string }
  | { action: 'unset'; key: string }
  | { action: 'list' }
  | { action: 'help' };

export type SecretCommandOpts = {
  /** Absolute path to the .env file to manage. */
  envPath: string;
};

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseSecretCommand(content: string): SecretCommand | null {
  const trimmed = content.trim();
  if (!/^!secret(?:\s|$)/.test(trimmed)) return null;

  const rest = trimmed.slice('!secret'.length).trim();

  if (!rest || rest === 'help') return { action: 'help' };
  if (rest === 'list') return { action: 'list' };

  if (rest.startsWith('unset ')) {
    const key = rest.slice('unset '.length).trim();
    if (!ENV_KEY_RE.test(key)) return null;
    return { action: 'unset', key };
  }

  if (rest.startsWith('set ')) {
    const pair = rest.slice('set '.length);
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) return null;
    const key = pair.slice(0, eqIdx).trim();
    if (!ENV_KEY_RE.test(key)) return null;
    const value = pair.slice(eqIdx + 1);
    return { action: 'set', key, value };
  }

  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Handles a parsed !secret command.
 *
 * Security contract:
 * - Secret values are NEVER included in the returned reply string.
 * - Writes go through an atomic tmp-file rename so partial writes can't corrupt .env.
 * - DM-only enforcement is the caller's responsibility (message-coordinator).
 */
export async function handleSecretCommand(
  cmd: SecretCommand,
  opts: SecretCommandOpts,
): Promise<string> {
  try {
    if (cmd.action === 'help') {
      return [
        '**!secret commands** (DM only — values are never echoed)',
        '- `!secret set KEY=value` — add or update a .env entry',
        '- `!secret unset KEY` — remove a .env entry',
        '- `!secret list` — list key names in .env (values hidden)',
        '- `!secret help` — this message',
      ].join('\n');
    }

    if (cmd.action === 'list') {
      const lines = await readEnvLines(opts.envPath);
      const keys = listEnvKeys(lines);
      if (keys.length === 0) return 'No entries in .env.';
      return `**Keys in .env** (values hidden):\n${keys.map((k) => `- \`${k}\``).join('\n')}`;
    }

    if (cmd.action === 'set') {
      if (cmd.value.includes('\n') || cmd.value.includes('\r')) {
        return 'Secret values cannot contain newlines.';
      }
      const lines = await readEnvLines(opts.envPath);
      const updated = upsertEnvKey(lines, cmd.key, cmd.value);
      await atomicWriteEnv(opts.envPath, updated);
      return `Set \`${cmd.key}\`. Restart the bot for changes to take effect.`;
    }

    if (cmd.action === 'unset') {
      const lines = await readEnvLines(opts.envPath);
      const { updated, removed } = removeEnvKey(lines, cmd.key);
      if (!removed) return `Key \`${cmd.key}\` was not found in .env.`;
      await atomicWriteEnv(opts.envPath, updated);
      return `Removed \`${cmd.key}\`. Restart the bot for changes to take effect.`;
    }

    return 'Unknown secret command.';
  } catch (err) {
    return `Secret command error: ${String(err)}`;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function readEnvLines(envPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(envPath, 'utf8');
    return content.split('\n');
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Returns all active (non-comment, non-blank) key names from .env lines. */
export function listEnvKeys(lines: string[]): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (ENV_KEY_RE.test(key)) keys.push(key);
  }
  return keys;
}

/**
 * Returns a new lines array with the given key set to value.
 * Replaces the first matching active line in-place; appends if not found.
 */
export function upsertEnvKey(lines: string[], key: string, value: string): string[] {
  const result = [...lines];
  const prefix = `${key}=`;
  for (let i = 0; i < result.length; i++) {
    const trimmed = result[i].trim();
    if (!trimmed.startsWith('#') && trimmed.startsWith(prefix)) {
      result[i] = `${key}=${value}`;
      return result;
    }
  }
  // Key not found — append before trailing blank line if present.
  if (result.length > 0 && result[result.length - 1] === '') {
    result.splice(result.length - 1, 0, `${key}=${value}`);
  } else {
    result.push(`${key}=${value}`);
  }
  return result;
}

/**
 * Returns a new lines array with all active lines for the given key removed,
 * plus a flag indicating whether anything was actually removed.
 */
export function removeEnvKey(lines: string[], key: string): { updated: string[]; removed: boolean } {
  const prefix = `${key}=`;
  let removed = false;
  const updated = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#') && trimmed.startsWith(prefix)) {
      removed = true;
      return false;
    }
    return true;
  });
  return { updated, removed };
}

async function atomicWriteEnv(envPath: string, lines: string[]): Promise<void> {
  const tmpPath = `${envPath}.tmp`;
  await fs.writeFile(tmpPath, lines.join('\n'), 'utf8');
  await fs.rename(tmpPath, envPath);
}
