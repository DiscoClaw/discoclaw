import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseUpdateCommand, handleUpdateCommand } from './update-command.js';
import * as shutdownCtx from './shutdown-context.js';
import * as registry from './forge-plan-registry.js';

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    // Default: all commands succeed with empty output.
    if (cb) cb(null, '', '');
  }),
}));

vi.mock('../npm-managed.js', () => ({
  isNpmManaged: vi.fn().mockResolvedValue(false),
  getLocalVersion: vi.fn().mockReturnValue('1.0.0'),
  getLatestNpmVersion: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// parseUpdateCommand
// ---------------------------------------------------------------------------

describe('parseUpdateCommand', () => {
  it('parses !update as check action', () => {
    expect(parseUpdateCommand('!update')).toEqual({ action: 'check' });
  });

  it('parses !update apply', () => {
    expect(parseUpdateCommand('!update apply')).toEqual({ action: 'apply' });
  });

  it('parses !update help', () => {
    expect(parseUpdateCommand('!update help')).toEqual({ action: 'help' });
  });

  it('returns null for non-update messages', () => {
    expect(parseUpdateCommand('hello')).toBeNull();
    expect(parseUpdateCommand('!restart')).toBeNull();
    expect(parseUpdateCommand('!updating')).toBeNull();
    expect(parseUpdateCommand('!update unknown')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseUpdateCommand('!UPDATE')).toEqual({ action: 'check' });
    expect(parseUpdateCommand('!Update Apply')).toEqual({ action: 'apply' });
    expect(parseUpdateCommand('!Update Help')).toEqual({ action: 'help' });
  });

  it('handles surrounding whitespace', () => {
    expect(parseUpdateCommand('  !update  ')).toEqual({ action: 'check' });
    expect(parseUpdateCommand('  !update  apply  ')).toEqual({ action: 'apply' });
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCommand — help
// ---------------------------------------------------------------------------

describe('handleUpdateCommand: help', () => {
  it('returns usage text without calling execFile', async () => {
    const { execFile } = await import('node:child_process');
    vi.clearAllMocks();
    const result = await handleUpdateCommand({ action: 'help' });
    expect(result.reply).toContain('!update commands');
    expect(result.reply).toContain('!update apply');
    expect(result.deferred).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCommand — check
// ---------------------------------------------------------------------------

describe('handleUpdateCommand: check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports "up to date" when git log returns empty output', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      cb(null, '', '');
    });
    const result = await handleUpdateCommand({ action: 'check' });
    expect(result.reply).toBe('Already up to date.');
    expect(result.deferred).toBeUndefined();
  });

  it('lists available commits when git log has output', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (args.includes('log')) {
        cb(null, 'abc1234 Fix a bug\ndef5678 Add feature\n', '');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'check' });
    expect(result.reply).toContain('Available updates from main');
    expect(result.reply).toContain('abc1234');
    expect(result.reply).toContain('def5678');
  });

  it('reports error when git fetch fails', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (args.includes('fetch')) {
        const err: any = new Error('network error');
        err.code = 1;
        cb(err, '', 'network error');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'check' });
    expect(result.reply).toContain('Failed to fetch');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCommand — apply
// ---------------------------------------------------------------------------

describe('handleUpdateCommand: apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(registry, 'getActiveOrchestrator').mockReturnValue(null);
    vi.spyOn(registry, 'getRunningPlanIds').mockReturnValue(new Set());
  });

  function mockAllSuccess() {
    return vi.fn((cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (cb) cb(null, '', '');
    });
  }

  it('aborts when a forge run is active', async () => {
    vi.spyOn(registry, 'getActiveOrchestrator').mockReturnValue({ isRunning: true } as any);
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('forge run is in progress');
    expect(result.deferred).toBeUndefined();
  });

  it('aborts when a plan run is active', async () => {
    vi.spyOn(registry, 'getRunningPlanIds').mockReturnValue(new Set(['plan-001']));
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('plan run is in progress');
    expect(result.deferred).toBeUndefined();
  });

  it('aborts when working tree is dirty', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (args.includes('--porcelain')) {
        cb(null, 'M src/index.ts\n', '');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('uncommitted changes');
    expect(result.deferred).toBeUndefined();
  });

  it('aborts and reports error when git pull fails', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (args.includes('pull')) {
        const err: any = new Error('merge conflict');
        err.code = 1;
        cb(err, '', 'merge conflict');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('git pull');
    expect(result.reply).toContain('failed');
    expect(result.deferred).toBeUndefined();
  });

  it('aborts and reports error when pnpm install fails', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (cmd === 'pnpm' && args.includes('install')) {
        const err: any = new Error('install failed');
        err.code = 1;
        cb(err, '', 'install failed');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('pnpm install');
    expect(result.reply).toContain('failed');
    expect(result.deferred).toBeUndefined();
  });

  it('aborts and reports error when pnpm build fails', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (cmd === 'pnpm' && args.includes('build')) {
        const err: any = new Error('build failed');
        err.code = 1;
        cb(err, '', 'build failed');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('pnpm build');
    expect(result.reply).toContain('failed');
    expect(result.deferred).toBeUndefined();
  });

  it('returns a deferred restart function on full success', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation(mockAllSuccess());
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('Restarting discoclaw');
    expect(typeof result.deferred).toBe('function');
  });

  it('deferred writes shutdown context before restarting', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation(mockAllSuccess());
    const spy = vi.spyOn(shutdownCtx, 'writeShutdownContext').mockResolvedValue();

    const result = await handleUpdateCommand(
      { action: 'apply' },
      { dataDir: '/tmp/test', userId: '999' },
    );
    expect(spy).not.toHaveBeenCalled();
    result.deferred!();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toMatchObject({
      reason: 'restart-command',
      requestedBy: '999',
    });
    spy.mockRestore();
  });

  it('deferred uses systemctl restart by default', async () => {
    const { execFile } = await import('node:child_process');
    const mock = mockAllSuccess();
    (execFile as any).mockImplementation(mock);

    const result = await handleUpdateCommand({ action: 'apply' });
    result.deferred!();

    // Find the restart call — it's the last execFile call after the pipeline.
    const calls: any[] = (execFile as any).mock.calls;
    const restartCall = calls.find(
      ([cmd, args]: [string, string[]]) => cmd === 'systemctl' && args.includes('restart'),
    );
    expect(restartCall).toBeDefined();
    expect(restartCall[1]).toEqual(['--user', 'restart', 'discoclaw']);
  });

  it('deferred uses launchctl kickstart on macOS', async () => {
    const { execFile } = await import('node:child_process');
    const mock = mockAllSuccess();
    (execFile as any).mockImplementation(mock);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const originalGetuid = process.getuid;
    process.getuid = () => 501;

    try {
      const result = await handleUpdateCommand({ action: 'apply' });
      result.deferred!();

      const calls: any[] = (execFile as any).mock.calls;
      const restartCall = calls.find(
        ([cmd, args]: [string, string[]]) => cmd === 'launchctl' && args.includes('kickstart'),
      );
      expect(restartCall).toBeDefined();
      expect(restartCall[1]).toContain('-k');
      expect(restartCall[1].some((a: string) => a.includes('com.discoclaw.discoclaw'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.getuid = originalGetuid;
    }
  });

  it('deferred uses restartCmd via /bin/sh when provided', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation(mockAllSuccess());

    const result = await handleUpdateCommand(
      { action: 'apply' },
      { restartCmd: 'sudo systemctl restart discoclaw' },
    );
    result.deferred!();

    const calls: any[] = (execFile as any).mock.calls;
    const shCall = calls.find(([cmd]: [string]) => cmd === '/bin/sh');
    expect(shCall).toBeDefined();
    expect(shCall[1]).toEqual(['-c', 'sudo systemctl restart discoclaw']);
  });

  it('deferred passes custom serviceName to getRestartCmdArgs (git-managed)', async () => {
    const { execFile } = await import('node:child_process');
    const mock = mockAllSuccess();
    (execFile as any).mockImplementation(mock);

    const result = await handleUpdateCommand(
      { action: 'apply' },
      { serviceName: 'discoclaw-beta' },
    );
    result.deferred!();

    const calls: any[] = (execFile as any).mock.calls;
    const restartCall = calls.find(
      ([cmd, args]: [string, string[]]) => cmd === 'systemctl' && args.includes('restart'),
    );
    expect(restartCall).toBeDefined();
    expect(restartCall[1]).toEqual(['--user', 'restart', 'discoclaw-beta']);
  });

  it('calls onProgress callback for each step', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation(mockAllSuccess());

    const progress: string[] = [];
    await handleUpdateCommand(
      { action: 'apply' },
      { onProgress: (msg) => progress.push(msg) },
    );

    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress.some((m) => m.includes('working tree') || m.includes('Checking'))).toBe(true);
    expect(progress.some((m) => m.includes('pull') || m.includes('Pulling'))).toBe(true);
    expect(progress.some((m) => m.includes('install'))).toBe(true);
    expect(progress.some((m) => m.includes('build'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCommand — npm-managed mode
// ---------------------------------------------------------------------------

describe('handleUpdateCommand: npm-managed mode', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(registry, 'getActiveOrchestrator').mockReturnValue(null);
    vi.spyOn(registry, 'getRunningPlanIds').mockReturnValue(new Set());

    const mod = await import('../npm-managed.js');
    (mod.isNpmManaged as any).mockResolvedValue(true);
    (mod.getLocalVersion as any).mockReturnValue('1.2.3');
    (mod.getLatestNpmVersion as any).mockResolvedValue('1.2.3');
  });

  it('check reports "already on latest" when versions match', async () => {
    const result = await handleUpdateCommand({ action: 'check' });
    expect(result.reply).toContain('Already on latest');
    expect(result.reply).toContain('1.2.3');
    expect(result.deferred).toBeUndefined();
  });

  it('check reports available update when behind', async () => {
    const mod = await import('../npm-managed.js');
    (mod.getLatestNpmVersion as any).mockResolvedValue('1.3.0');
    const result = await handleUpdateCommand({ action: 'check' });
    expect(result.reply).toContain('1.2.3');
    expect(result.reply).toContain('1.3.0');
    expect(result.deferred).toBeUndefined();
  });

  it('check handles npm view failure gracefully', async () => {
    const mod = await import('../npm-managed.js');
    (mod.getLatestNpmVersion as any).mockResolvedValue(null);
    const result = await handleUpdateCommand({ action: 'check' });
    expect(result.reply).toContain('Failed');
    expect(result.deferred).toBeUndefined();
  });

  it('apply runs npm install -g discoclaw@latest and returns deferred restart', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      cb(null, '', '');
    });
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('Restarting discoclaw');
    expect(typeof result.deferred).toBe('function');
    const calls: any[] = (execFile as any).mock.calls;
    const installCall = calls.find(
      ([cmd, args]: [string, string[]]) =>
        cmd === 'npm' && args.includes('install') && args.includes('discoclaw@latest'),
    );
    expect(installCall).toBeDefined();
    expect(installCall[1]).toContain('--loglevel=error');
  });

  it('apply reports error on install failure', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], opts: any, cb: any) => {
      if (cmd === 'npm') {
        const err: any = new Error('install failed');
        err.code = 1;
        cb(err, '', 'install failed');
      } else {
        cb(null, '', '');
      }
    });
    const result = await handleUpdateCommand({ action: 'apply' });
    expect(result.reply).toContain('failed');
    expect(result.deferred).toBeUndefined();
  });

  it('deferred passes custom serviceName to getRestartCmdArgs (npm-managed)', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementation((cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (cb) cb(null, '', '');
    });

    const result = await handleUpdateCommand(
      { action: 'apply' },
      { serviceName: 'discoclaw-beta' },
    );
    result.deferred!();

    const calls: any[] = (execFile as any).mock.calls;
    const restartCall = calls.find(
      ([cmd, args]: [string, string[]]) => cmd === 'systemctl' && args.includes('restart'),
    );
    expect(restartCall).toBeDefined();
    expect(restartCall[1]).toEqual(['--user', 'restart', 'discoclaw-beta']);
  });
});
