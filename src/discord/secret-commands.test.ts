import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseSecretCommand,
  handleSecretCommand,
  listEnvKeys,
  upsertEnvKey,
  removeEnvKey,
} from './secret-commands.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'secret-commands-test-'));
}

// ── parseSecretCommand ────────────────────────────────────────────────────────

describe('parseSecretCommand', () => {
  it('returns null for non-commands', () => {
    expect(parseSecretCommand('hello world')).toBeNull();
    expect(parseSecretCommand('!memory show')).toBeNull();
    expect(parseSecretCommand('!secretset KEY=val')).toBeNull();
    expect(parseSecretCommand('')).toBeNull();
  });

  it('parses bare !secret as help', () => {
    expect(parseSecretCommand('!secret')).toEqual({ action: 'help' });
  });

  it('parses !secret help', () => {
    expect(parseSecretCommand('!secret help')).toEqual({ action: 'help' });
  });

  it('parses !secret list', () => {
    expect(parseSecretCommand('!secret list')).toEqual({ action: 'list' });
  });

  it('parses !secret set KEY=value', () => {
    expect(parseSecretCommand('!secret set OPENAI_API_KEY=sk-abc123')).toEqual({
      action: 'set',
      key: 'OPENAI_API_KEY',
      value: 'sk-abc123',
    });
  });

  it('parses !secret set KEY=value where value contains = signs', () => {
    expect(parseSecretCommand('!secret set DB_URL=postgres://user:pass@host/db?ssl=true')).toEqual({
      action: 'set',
      key: 'DB_URL',
      value: 'postgres://user:pass@host/db?ssl=true',
    });
  });

  it('parses !secret set KEY= (empty value)', () => {
    expect(parseSecretCommand('!secret set MY_KEY=')).toEqual({
      action: 'set',
      key: 'MY_KEY',
      value: '',
    });
  });

  it('parses !secret unset KEY', () => {
    expect(parseSecretCommand('!secret unset OPENAI_API_KEY')).toEqual({
      action: 'unset',
      key: 'OPENAI_API_KEY',
    });
  });

  it('returns null for invalid key name with spaces', () => {
    expect(parseSecretCommand('!secret set MY KEY=val')).toBeNull();
  });

  it('returns null for key starting with a digit', () => {
    expect(parseSecretCommand('!secret set 1KEY=val')).toBeNull();
  });

  it('returns null for key with dashes', () => {
    expect(parseSecretCommand('!secret set MY-KEY=val')).toBeNull();
  });

  it('returns null for !secret set =VALUE (empty key)', () => {
    expect(parseSecretCommand('!secret set =VALUE')).toBeNull();
  });

  it('returns null for !secret set KEY (missing equals)', () => {
    expect(parseSecretCommand('!secret set NOEQUALS')).toBeNull();
  });

  it('returns null for !secret unset with no key', () => {
    expect(parseSecretCommand('!secret unset ')).toBeNull();
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseSecretCommand('  !secret  list  ')).toEqual({ action: 'list' });
    // The outer content.trim() strips trailing whitespace before value extraction.
    expect(parseSecretCommand('  !secret  set  MY_KEY=val  ')).toEqual({
      action: 'set',
      key: 'MY_KEY',
      value: 'val',
    });
  });
});

// ── handleSecretCommand ───────────────────────────────────────────────────────

describe('handleSecretCommand — help', () => {
  it('returns usage text without touching the filesystem', async () => {
    const result = await handleSecretCommand(
      { action: 'help' },
      { envPath: '/nonexistent/.env' },
    );
    expect(result).toContain('!secret commands');
    expect(result).toContain('DM only');
    expect(result).toContain('values are never echoed');
    expect(result).toContain('!secret set KEY=value');
    expect(result).toContain('!secret unset KEY');
    expect(result).toContain('!secret list');
  });
});

describe('handleSecretCommand — list', () => {
  it('returns "No entries" when .env does not exist', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    const result = await handleSecretCommand({ action: 'list' }, { envPath });
    expect(result).toBe('No entries in .env.');
  });

  it('returns only key names, not values', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, 'OPENAI_API_KEY=sk-super-secret\nDISCORD_TOKEN=xoxb-secret\n', 'utf8');

    const result = await handleSecretCommand({ action: 'list' }, { envPath });
    expect(result).toContain('OPENAI_API_KEY');
    expect(result).toContain('DISCORD_TOKEN');
    expect(result).not.toContain('sk-super-secret');
    expect(result).not.toContain('xoxb-secret');
  });

  it('skips comments and blank lines', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(
      envPath,
      '# This is a comment\n\nACTIVE_KEY=value\n# another comment\n',
      'utf8',
    );

    const result = await handleSecretCommand({ action: 'list' }, { envPath });
    expect(result).toContain('ACTIVE_KEY');
    expect(result).not.toContain('#');
  });
});

describe('handleSecretCommand — set', () => {
  it('creates .env if it does not exist', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');

    const result = await handleSecretCommand(
      { action: 'set', key: 'NEW_KEY', value: 'newvalue' },
      { envPath },
    );
    expect(result).toContain('Set `NEW_KEY`');
    expect(result).toContain('Restart the bot');

    const content = await fs.readFile(envPath, 'utf8');
    expect(content).toContain('NEW_KEY=newvalue');
  });

  it('adds a new key to an existing .env', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, 'EXISTING_KEY=existingvalue\n', 'utf8');

    await handleSecretCommand({ action: 'set', key: 'NEW_KEY', value: 'newvalue' }, { envPath });

    const content = await fs.readFile(envPath, 'utf8');
    expect(content).toContain('EXISTING_KEY=existingvalue');
    expect(content).toContain('NEW_KEY=newvalue');
  });

  it('updates existing key in-place', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, '# comment\nOLD_KEY=oldvalue\nANOTHER=x\n', 'utf8');

    await handleSecretCommand({ action: 'set', key: 'OLD_KEY', value: 'newvalue' }, { envPath });

    const content = await fs.readFile(envPath, 'utf8');
    expect(content).toContain('OLD_KEY=newvalue');
    expect(content).not.toContain('OLD_KEY=oldvalue');
    // Preserves other lines
    expect(content).toContain('ANOTHER=x');
    expect(content).toContain('# comment');
  });

  it('does not echo the value in the reply', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');

    const secretValue = 'sk-this-must-never-appear-in-reply-1234567890';
    const result = await handleSecretCommand(
      { action: 'set', key: 'SECRET_KEY', value: secretValue },
      { envPath },
    );
    expect(result).not.toContain(secretValue);
    expect(result).toContain('`SECRET_KEY`');
  });

  it('rejects values with newlines', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');

    const result = await handleSecretCommand(
      { action: 'set', key: 'MY_KEY', value: 'line1\nline2' },
      { envPath },
    );
    expect(result).toContain('cannot contain newlines');
    // Verify .env was not written
    await expect(fs.readFile(envPath, 'utf8')).rejects.toThrow();
  });

  it('writes atomically — no .env.tmp left behind', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');

    await handleSecretCommand({ action: 'set', key: 'K', value: 'v' }, { envPath });

    // The .env.tmp file must not exist after a successful write.
    await expect(fs.access(`${envPath}.tmp`)).rejects.toThrow();
    // The .env file must exist.
    const content = await fs.readFile(envPath, 'utf8');
    expect(content).toContain('K=v');
  });

  it('preserves trailing newline in .env after update', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, 'FIRST=a\n', 'utf8');

    await handleSecretCommand({ action: 'set', key: 'SECOND', value: 'b' }, { envPath });

    const content = await fs.readFile(envPath, 'utf8');
    // Both keys present, trailing newline preserved
    expect(content).toContain('FIRST=a');
    expect(content).toContain('SECOND=b');
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('handleSecretCommand — unset', () => {
  it('removes an existing key', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, 'TO_REMOVE=secret\nKEEP=me\n', 'utf8');

    const result = await handleSecretCommand({ action: 'unset', key: 'TO_REMOVE' }, { envPath });
    expect(result).toContain('Removed `TO_REMOVE`');
    expect(result).toContain('Restart the bot');

    const content = await fs.readFile(envPath, 'utf8');
    expect(content).not.toContain('TO_REMOVE');
    expect(content).toContain('KEEP=me');
  });

  it('reports when key was not found', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');
    await fs.writeFile(envPath, 'OTHER=val\n', 'utf8');

    const result = await handleSecretCommand({ action: 'unset', key: 'MISSING' }, { envPath });
    expect(result).toContain('`MISSING`');
    expect(result).toContain('not found');
  });

  it('reports not found when .env does not exist', async () => {
    const dir = await makeTmpDir();
    const envPath = path.join(dir, '.env');

    const result = await handleSecretCommand({ action: 'unset', key: 'ANY_KEY' }, { envPath });
    expect(result).toContain('not found');
  });
});

// ── unit tests for exported helpers ──────────────────────────────────────────

describe('listEnvKeys', () => {
  it('returns empty array for empty input', () => {
    expect(listEnvKeys([])).toEqual([]);
  });

  it('ignores comments and blank lines', () => {
    expect(listEnvKeys(['# comment', '', 'KEY=val'])).toEqual(['KEY']);
  });

  it('returns all active keys', () => {
    const lines = ['A=1', '# skip', '', 'B=2', 'C=3'];
    expect(listEnvKeys(lines)).toEqual(['A', 'B', 'C']);
  });

  it('ignores lines without =', () => {
    expect(listEnvKeys(['NOEQUALS'])).toEqual([]);
  });
});

describe('upsertEnvKey', () => {
  it('appends a new key to an empty array', () => {
    expect(upsertEnvKey([], 'KEY', 'val')).toEqual(['KEY=val']);
  });

  it('replaces an existing key in-place', () => {
    const result = upsertEnvKey(['KEY=old', 'OTHER=x'], 'KEY', 'new');
    expect(result).toEqual(['KEY=new', 'OTHER=x']);
  });

  it('appends new key before trailing blank line', () => {
    const result = upsertEnvKey(['EXISTING=a', ''], 'NEW', 'b');
    expect(result).toEqual(['EXISTING=a', 'NEW=b', '']);
  });

  it('does not modify commented-out entries of the same name', () => {
    const result = upsertEnvKey(['# KEY=commented', 'KEY=active'], 'KEY', 'updated');
    expect(result).toEqual(['# KEY=commented', 'KEY=updated']);
  });
});

describe('removeEnvKey', () => {
  it('returns removed=false when key not present', () => {
    const { updated, removed } = removeEnvKey(['A=1'], 'MISSING');
    expect(removed).toBe(false);
    expect(updated).toEqual(['A=1']);
  });

  it('removes the matching line and returns removed=true', () => {
    const { updated, removed } = removeEnvKey(['A=1', 'B=2', 'C=3'], 'B');
    expect(removed).toBe(true);
    expect(updated).toEqual(['A=1', 'C=3']);
  });

  it('does not remove commented-out entries', () => {
    const { updated, removed } = removeEnvKey(['# KEY=commented', 'KEY=active'], 'KEY');
    expect(removed).toBe(true);
    expect(updated).toEqual(['# KEY=commented']);
  });
});
