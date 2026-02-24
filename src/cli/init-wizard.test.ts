import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../workspace-bootstrap.js', () => ({
  ensureWorkspaceBootstrapFiles: vi.fn(async () => []),
}));

import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { ensureWorkspaceBootstrapFiles } from '../workspace-bootstrap.js';
import { backupFileName, buildEnvContent, runInitWizard, selectDefaultProvider } from './init-wizard.js';

const initialSigintListeners = new Set(process.listeners('SIGINT'));
const initialSigtermListeners = new Set(process.listeners('SIGTERM'));
const originalIsTTY = (process.stdin as any).isTTY;

function makeReadline(answers: string[]) {
  let closeHandler: (() => void) | undefined;
  return {
    question: vi.fn(async () => answers.shift() ?? ''),
    close: vi.fn(() => {
      closeHandler?.();
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandler = cb;
    }),
  };
}

describe('init wizard helpers', () => {
  it('formats backup filenames from timestamps', () => {
    const name = backupFileName(new Date('2026-02-21T18:45:12.999Z'));
    expect(name).toBe('.env.backup.20260221T184512');
  });

  it('builds env content with provider/core/optional sections', () => {
    const content = buildEnvContent(
      {
        DISCORD_TOKEN: 'a.b.c',
        DISCORD_ALLOW_USER_IDS: '1000000000000000001',
        DISCOCLAW_TASKS_FORUM: '1000000000000000002',
        DISCOCLAW_CRON_FORUM: '1000000000000000003',
        PRIMARY_RUNTIME: 'claude',
        CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: '1',
        CLAUDE_OUTPUT_FORMAT: 'stream-json',
        DISCORD_GUILD_ID: '1000000000000000004',
        DISCOCLAW_DISCORD_ACTIONS: '1',
      },
      new Date('2026-02-21T00:00:00.000Z'),
    );

    expect(content).toContain('# REQUIRED');
    expect(content).toContain('PRIMARY_RUNTIME=claude');
    expect(content).toContain('CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1');
    expect(content).toContain('# CORE');
    expect(content).toContain('DISCORD_GUILD_ID=1000000000000000004');
    expect(content).toContain('# OPTIONAL');
    expect(content).toContain('DISCOCLAW_DISCORD_ACTIONS=1');
    // Forum IDs are auto-detected, not in REQUIRED
    expect(content).toContain('# AUTO-DETECTED');
    expect(content).toContain('DISCOCLAW_TASKS_FORUM=1000000000000000002');
    expect(content).toContain('DISCOCLAW_CRON_FORUM=1000000000000000003');
    // Forum IDs must not appear before the AUTO-DETECTED header
    const requiredIdx = content.indexOf('# REQUIRED');
    const autoDetectedIdx = content.indexOf('# AUTO-DETECTED');
    const tasksIdx = content.indexOf('DISCOCLAW_TASKS_FORUM=');
    expect(tasksIdx).toBeGreaterThan(autoDetectedIdx);
    expect(autoDetectedIdx).toBeGreaterThan(requiredIdx);
  });

  it('selects provider defaults in expected precedence order', () => {
    expect(selectDefaultProvider(['codex'])).toBe('4');
    expect(selectDefaultProvider(['gemini', 'codex'])).toBe('2');
    expect(selectDefaultProvider(['claude', 'gemini', 'codex'])).toBe('1');
    expect(selectDefaultProvider([])).toBe('1');
  });

  it('returns default provider 1 when no OpenRouter runtime is detected (HTTP-only, no binary)', () => {
    // OpenRouter has no CLI binary so detection never adds it to the list
    expect(selectDefaultProvider([])).toBe('1');
    expect(selectDefaultProvider(['openrouter'])).toBe('1');
  });

  it('includes OpenRouter keys in generated env content', () => {
    const content = buildEnvContent(
      {
        DISCORD_TOKEN: 'a.b.c',
        DISCORD_ALLOW_USER_IDS: '1000000000000000001',
        DISCOCLAW_TASKS_FORUM: '1000000000000000002',
        DISCOCLAW_CRON_FORUM: '1000000000000000003',
        PRIMARY_RUNTIME: 'openrouter',
        OPENROUTER_API_KEY: 'sk-or-test-key',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_MODEL: 'anthropic/claude-sonnet-4',
      },
      new Date('2026-02-22T00:00:00.000Z'),
    );

    expect(content).toContain('PRIMARY_RUNTIME=openrouter');
    expect(content).toContain('OPENROUTER_API_KEY=sk-or-test-key');
    expect(content).toContain('OPENROUTER_BASE_URL=https://openrouter.ai/api/v1');
    expect(content).toContain('OPENROUTER_MODEL=anthropic/claude-sonnet-4');
    expect(content).toContain('# AUTO-DETECTED');
    expect(content).toContain('DISCOCLAW_TASKS_FORUM=1000000000000000002');
    expect(content).toContain('DISCOCLAW_CRON_FORUM=1000000000000000003');
  });

  it('writes DISCOCLAW_DATA_DIR in required section when provided', () => {
    const content = buildEnvContent(
      {
        DISCORD_TOKEN: 'a.b.c',
        DISCORD_ALLOW_USER_IDS: '1000000000000000001',
        DISCOCLAW_DATA_DIR: '/home/user/discoclaw-data',
      },
      new Date('2026-02-23T00:00:00.000Z'),
    );

    expect(content).toContain('DISCOCLAW_DATA_DIR=/home/user/discoclaw-data');
    // Must appear inside the REQUIRED section (before any PROVIDER or AUTO-DETECTED section)
    const requiredIdx = content.indexOf('# REQUIRED');
    const dataDirIdx = content.indexOf('DISCOCLAW_DATA_DIR=');
    expect(dataDirIdx).toBeGreaterThan(requiredIdx);
    // No AUTO-DETECTED section when no forum IDs are present
    expect(content).not.toContain('# AUTO-DETECTED');
  });

  it('omits auto-detected section when no forum IDs are present', () => {
    const content = buildEnvContent(
      {
        DISCORD_TOKEN: 'a.b.c',
        DISCORD_ALLOW_USER_IDS: '1000000000000000001',
      },
      new Date('2026-02-23T00:00:00.000Z'),
    );

    expect(content).not.toContain('# AUTO-DETECTED');
    expect(content).not.toContain('DISCOCLAW_TASKS_FORUM');
    expect(content).not.toContain('DISCOCLAW_CRON_FORUM');
  });
});

describe('runInitWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (process.stdin as any).isTTY = true;
  });

  afterEach(() => {
    (process.stdin as any).isTTY = originalIsTTY;
    for (const listener of process.listeners('SIGINT')) {
      if (!initialSigintListeners.has(listener)) process.removeListener('SIGINT', listener);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!initialSigtermListeners.has(listener)) process.removeListener('SIGTERM', listener);
    }
    vi.restoreAllMocks();
  });

  it('rejects non-interactive terminals', async () => {
    (process.stdin as any).isTTY = false;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any);

    await expect(runInitWizard()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith('discoclaw init requires an interactive terminal.\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(vi.mocked(createInterface)).not.toHaveBeenCalled();
  });

  it('backs up an existing .env before overwrite and writes new config', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-init-test-'));
    const previousCwd = process.cwd();
    const oldEnv = 'DISCORD_TOKEN=old.token.value\nDISCORD_ALLOW_USER_IDS=111111111111111111\n';
    const answers = [
      '', // install directory (default)
      '', // Press Enter to continue
      '', // data directory (default cwd/data)
      'y', // Overwrite existing .env
      'a.b.c', // DISCORD_TOKEN
      '1000000000000000001', // DISCORD_ALLOW_USER_IDS
      '', // provider selection -> default (Claude)
      '', // enable skip permissions
      '', // enable stream-json
      'n', // configure recommended settings
      'n', // configure optional features
    ];

    fs.writeFileSync(path.join(tmpDir, '.env'), oldEnv, 'utf8');
    process.chdir(tmpDir);

    vi.mocked(createInterface).mockReturnValue(makeReadline(answers) as any);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('binary not found');
    });
    vi.mocked(ensureWorkspaceBootstrapFiles).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInitWizard();
    } finally {
      process.chdir(previousCwd);
    }

    const backupFiles = fs.readdirSync(tmpDir).filter((name) => name.startsWith('.env.backup.'));
    expect(backupFiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, backupFiles[0]), 'utf8')).toBe(oldEnv);

    const newEnv = fs.readFileSync(path.join(tmpDir, '.env'), 'utf8');
    expect(newEnv).toContain('DISCORD_TOKEN=a.b.c');
    expect(newEnv).toContain('PRIMARY_RUNTIME=claude');
    expect(newEnv).toContain('CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1');
    expect(newEnv).toContain('CLAUDE_OUTPUT_FORMAT=stream-json');
    expect(newEnv).toContain(`DISCOCLAW_DATA_DIR=${path.join(tmpDir, 'data')}`);
    expect(ensureWorkspaceBootstrapFiles).toHaveBeenCalledWith(path.join(tmpDir, 'workspace'));
  });

  it('writes openrouter config when provider 5 is selected', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-init-test-'));
    const previousCwd = process.cwd();
    const answers = [
      '', // install directory (default)
      '', // Press Enter to continue
      '', // data directory (default cwd/data)
      // no existing .env
      'a.b.c', // DISCORD_TOKEN
      '1000000000000000001', // DISCORD_ALLOW_USER_IDS
      '5', // provider selection -> OpenRouter
      'sk-or-test-key', // OPENROUTER_API_KEY
      '', // OPENROUTER_BASE_URL (optional, skip)
      '', // OPENROUTER_MODEL (optional, use default)
      'n', // configure recommended settings
      'n', // configure optional features
    ];

    process.chdir(tmpDir);

    vi.mocked(createInterface).mockReturnValue(makeReadline(answers) as any);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('binary not found');
    });
    vi.mocked(ensureWorkspaceBootstrapFiles).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInitWizard();
    } finally {
      process.chdir(previousCwd);
    }

    const newEnv = fs.readFileSync(path.join(tmpDir, '.env'), 'utf8');
    expect(newEnv).toContain('PRIMARY_RUNTIME=openrouter');
    expect(newEnv).toContain('OPENROUTER_API_KEY=sk-or-test-key');
    expect(newEnv).toContain('OPENROUTER_MODEL=anthropic/claude-sonnet-4');
    expect(newEnv).toContain(`DISCOCLAW_DATA_DIR=${path.join(tmpDir, 'data')}`);
  });

  it('always writes DISCOCLAW_DATA_DIR when a custom path is given', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-init-test-'));
    const previousCwd = process.cwd();
    const customDataDir = path.join(tmpDir, 'my-data');
    const answers = [
      '', // install directory (default)
      '', // Press Enter to continue
      customDataDir, // data directory (custom path)
      'a.b.c', // DISCORD_TOKEN
      '1000000000000000001', // DISCORD_ALLOW_USER_IDS
      '', // provider selection -> default (Claude)
      '', // enable skip permissions
      '', // enable stream-json
      'n', // configure recommended settings
      'n', // configure optional features
    ];

    process.chdir(tmpDir);

    vi.mocked(createInterface).mockReturnValue(makeReadline(answers) as any);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('binary not found');
    });
    vi.mocked(ensureWorkspaceBootstrapFiles).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInitWizard();
    } finally {
      process.chdir(previousCwd);
    }

    const newEnv = fs.readFileSync(path.join(tmpDir, '.env'), 'utf8');
    expect(newEnv).toContain(`DISCOCLAW_DATA_DIR=${customDataDir}`);
  });

  it('carries forward DISCOCLAW_TASKS_FORUM and DISCOCLAW_CRON_FORUM from existing .env on overwrite', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-init-test-'));
    const previousCwd = process.cwd();
    const oldEnv = [
      'DISCORD_TOKEN=old.token.value',
      'DISCORD_ALLOW_USER_IDS=111111111111111111',
      'DISCOCLAW_TASKS_FORUM=9000000000000000001',
      'DISCOCLAW_CRON_FORUM=9000000000000000002',
    ].join('\n') + '\n';

    const answers = [
      '', // install directory (default)
      '', // Press Enter to continue
      '', // data directory (default cwd/data)
      'y', // Overwrite existing .env
      'a.b.c', // DISCORD_TOKEN
      '1000000000000000001', // DISCORD_ALLOW_USER_IDS
      '', // provider selection -> default (Claude)
      '', // enable skip permissions
      '', // enable stream-json
      'n', // configure recommended settings
      'n', // configure optional features
    ];

    fs.writeFileSync(path.join(tmpDir, '.env'), oldEnv, 'utf8');
    process.chdir(tmpDir);

    vi.mocked(createInterface).mockReturnValue(makeReadline(answers) as any);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('binary not found');
    });
    vi.mocked(ensureWorkspaceBootstrapFiles).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInitWizard();
    } finally {
      process.chdir(previousCwd);
    }

    const newEnv = fs.readFileSync(path.join(tmpDir, '.env'), 'utf8');
    expect(newEnv).toContain('# AUTO-DETECTED');
    expect(newEnv).toContain('DISCOCLAW_TASKS_FORUM=9000000000000000001');
    expect(newEnv).toContain('DISCOCLAW_CRON_FORUM=9000000000000000002');
    // Must appear under AUTO-DETECTED, not REQUIRED
    const autoDetectedIdx = newEnv.indexOf('# AUTO-DETECTED');
    const tasksIdx = newEnv.indexOf('DISCOCLAW_TASKS_FORUM=');
    expect(tasksIdx).toBeGreaterThan(autoDetectedIdx);
  });

  it('uses a custom install directory when a path is provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-init-test-'));
    const answers = [
      tmpDir, // install directory (custom path)
      '', // Press Enter to continue
      '', // data directory (default)
      'a.b.c', // DISCORD_TOKEN
      '1000000000000000001', // DISCORD_ALLOW_USER_IDS
      '', // provider selection -> default (Claude)
      '', // enable skip permissions
      '', // enable stream-json
      'n', // configure recommended settings
      'n', // configure optional features
    ];

    vi.mocked(createInterface).mockReturnValue(makeReadline(answers) as any);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('binary not found');
    });
    vi.mocked(ensureWorkspaceBootstrapFiles).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInitWizard();

    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(true);
    expect(ensureWorkspaceBootstrapFiles).toHaveBeenCalledWith(path.join(tmpDir, 'workspace'));
  });

  it('creates the install directory if it does not exist', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-init-test-'));
    const newDir = path.join(baseDir, 'new-subdir');
    const answers = [
      newDir, // install directory (non-existent path)
      '', // Press Enter to continue
      '', // data directory (default)
      'a.b.c', // DISCORD_TOKEN
      '1000000000000000001', // DISCORD_ALLOW_USER_IDS
      '', // provider selection -> default (Claude)
      '', // enable skip permissions
      '', // enable stream-json
      'n', // configure recommended settings
      'n', // configure optional features
    ];

    vi.mocked(createInterface).mockReturnValue(makeReadline(answers) as any);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('binary not found');
    });
    vi.mocked(ensureWorkspaceBootstrapFiles).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runInitWizard();

    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.existsSync(path.join(newDir, '.env'))).toBe(true);
    expect(ensureWorkspaceBootstrapFiles).toHaveBeenCalledWith(path.join(newDir, 'workspace'));
  });
});
