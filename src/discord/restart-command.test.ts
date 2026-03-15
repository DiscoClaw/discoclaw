import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseRestartCommand, handleRestartCommand } from './restart-command.js';
import * as shutdownCtx from './shutdown-context.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    // Simulate systemctl status returning "active (running)"
    if (args.includes('status')) {
      cb(null, 'active (running)\n', '');
    } else if (args.includes('restart')) {
      cb(null, '', '');
    } else {
      // journalctl logs / launchctl list / log show / kickstart / bootstrap
      cb(null, 'Feb 12 14:00:00 discoclaw[1234]: started\n', '');
    }
  }),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: () => '/Users/testuser',
  },
}));

const savedPlatform = process.platform;

describe('parseRestartCommand', () => {
  it('parses !restart as restart action', () => {
    expect(parseRestartCommand('!restart')).toEqual({ action: 'restart' });
  });

  it('parses !restart status', () => {
    expect(parseRestartCommand('!restart status')).toEqual({ action: 'status' });
  });

  it('parses !restart logs', () => {
    expect(parseRestartCommand('!restart logs')).toEqual({ action: 'logs' });
  });

  it('parses !restart help', () => {
    expect(parseRestartCommand('!restart help')).toEqual({ action: 'help' });
  });

  it('returns null for non-restart messages', () => {
    expect(parseRestartCommand('hello')).toBeNull();
    expect(parseRestartCommand('!memory show')).toBeNull();
    expect(parseRestartCommand('!restarting')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseRestartCommand('!RESTART')).toEqual({ action: 'restart' });
    expect(parseRestartCommand('!Restart Status')).toEqual({ action: 'status' });
  });

  it('handles whitespace', () => {
    expect(parseRestartCommand('  !restart  ')).toEqual({ action: 'restart' });
    expect(parseRestartCommand('  !restart  status  ')).toEqual({ action: 'status' });
  });
});

describe('handleRestartCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('help returns usage text without calling execFile', async () => {
    const { execFile } = await import('node:child_process');
    const result = await handleRestartCommand({ action: 'help' });
    expect(result.reply).toContain('!restart commands');
    expect(result.deferred).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('status returns code-block output', async () => {
    const result = await handleRestartCommand({ action: 'status' });
    expect(result.reply).toContain('```');
    expect(result.reply).toContain('active (running)');
    expect(result.deferred).toBeUndefined();
  });

  it('logs returns code-block output', async () => {
    const result = await handleRestartCommand({ action: 'logs' });
    expect(result.reply).toContain('```');
    expect(result.reply).toContain('discoclaw');
    expect(result.deferred).toBeUndefined();
  });

  it('restart returns a deferred function and correct reply', async () => {
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toBe('Restarting discoclaw... back in a moment.');
    expect(typeof result.deferred).toBe('function');
  });

  it('does not write shutdown context until deferred is called', async () => {
    const spy = vi.spyOn(shutdownCtx, 'writeShutdownContext').mockResolvedValue();
    const result = await handleRestartCommand(
      { action: 'restart' },
      { dataDir: '/tmp/test', userId: '123', activeForge: 'plan-001' },
    );
    // Before deferred: no write.
    expect(spy).not.toHaveBeenCalled();
    // After deferred: write happens.
    result.deferred!();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toMatchObject({
      reason: 'restart-command',
      requestedBy: '123',
      activeForge: 'plan-001',
    });
    spy.mockRestore();
  });

  it('restart reports "Starting" when service was not active', async () => {
    const { execFile } = await import('node:child_process');
    // Override mock to simulate inactive service (only for the status-check call)
    (execFile as any).mockImplementationOnce(
      (cmd: string, args: string[], opts: any, cb: any) => {
        cb(null, 'inactive (dead)\n', '');
      },
    );
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toBe('Starting discoclaw...');
  });
});

describe('handleRestartCommand - macOS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(process as any, 'getuid').mockReturnValue(501);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it('status calls launchctl list instead of systemctl', async () => {
    const { execFile } = await import('node:child_process');
    const result = await handleRestartCommand({ action: 'status' });
    expect(result.reply).toContain('```');
    expect(result.deferred).toBeUndefined();
    const calls = (execFile as any).mock.calls;
    const statusCall = calls.find((c: any[]) => c[0] === 'launchctl');
    expect(statusCall).toBeDefined();
    expect(statusCall[1]).toContain('list');
    expect(statusCall[1]).toContain('com.discoclaw.discoclaw');
    // Must NOT call systemctl
    expect(calls.every((c: any[]) => c[0] !== 'systemctl')).toBe(true);
  });

  it('logs calls log show instead of journalctl', async () => {
    const { execFile } = await import('node:child_process');
    const result = await handleRestartCommand({ action: 'logs' });
    expect(result.reply).toContain('```');
    expect(result.deferred).toBeUndefined();
    const calls = (execFile as any).mock.calls;
    const logsCall = calls.find((c: any[]) => c[0] === 'log');
    expect(logsCall).toBeDefined();
    expect(logsCall[1]).toContain('show');
    expect(logsCall[1]).toContain('--predicate');
    // Must NOT call journalctl
    expect(calls.every((c: any[]) => c[0] !== 'journalctl')).toBe(true);
  });

  it('restart uses launchctl kickstart in deferred when service is active', async () => {
    const { execFile } = await import('node:child_process');
    // Default mock returns exit code 0 for launchctl list → wasActive = true
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toBe('Restarting discoclaw... back in a moment.');
    expect(typeof result.deferred).toBe('function');
    result.deferred!();
    const calls = (execFile as any).mock.calls;
    const kickstartCall = calls.find(
      (c: any[]) => c[0] === 'launchctl' && c[1].includes('kickstart'),
    );
    expect(kickstartCall).toBeDefined();
    expect(kickstartCall[1]).toContain('-k');
    expect(kickstartCall[1]).toContain('gui/501/com.discoclaw.discoclaw');
  });

  it('restart uses launchctl bootstrap in deferred when service is inactive', async () => {
    const { execFile } = await import('node:child_process');
    // Return non-zero exit code for the launchctl list check → wasActive = false
    (execFile as any).mockImplementationOnce(
      (cmd: string, args: string[], opts: any, cb: any) => {
        const err = Object.assign(new Error('not loaded'), { code: 1 });
        cb(err, '', '');
      },
    );
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toBe('Starting discoclaw...');
    expect(typeof result.deferred).toBe('function');
    result.deferred!();
    const calls = (execFile as any).mock.calls;
    const bootstrapCall = calls.find(
      (c: any[]) => c[0] === 'launchctl' && c[1].includes('bootstrap'),
    );
    expect(bootstrapCall).toBeDefined();
    expect(bootstrapCall[1]).toContain('gui/501');
    expect(bootstrapCall[1]).toContain(
      '/Users/testuser/Library/LaunchAgents/com.discoclaw.discoclaw.plist',
    );
  });
});

describe('handleRestartCommand - custom serviceName (Linux)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('default serviceName still targets discoclaw in systemctl args', async () => {
    const { execFile } = await import('node:child_process');
    await handleRestartCommand({ action: 'status' });
    const calls = (execFile as any).mock.calls;
    const statusCall = calls.find((c: any[]) => c[0] === 'systemctl');
    expect(statusCall[1]).toContain('discoclaw');
  });

  it('default restart reply still says "Restarting discoclaw..."', async () => {
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toBe('Restarting discoclaw... back in a moment.');
  });

  it('custom serviceName threads into systemctl status args', async () => {
    const { execFile } = await import('node:child_process');
    await handleRestartCommand({ action: 'status' }, { serviceName: 'discoclaw-beta' });
    const calls = (execFile as any).mock.calls;
    const statusCall = calls.find((c: any[]) => c[0] === 'systemctl' && c[1].includes('status'));
    expect(statusCall[1]).toContain('discoclaw-beta');
    expect(statusCall[1]).not.toContain('discoclaw-beta'.replace('discoclaw-beta', 'discoclaw'));
  });

  it('custom serviceName threads into journalctl logs args', async () => {
    const { execFile } = await import('node:child_process');
    await handleRestartCommand({ action: 'logs' }, { serviceName: 'discoclaw-beta' });
    const calls = (execFile as any).mock.calls;
    const logsCall = calls.find((c: any[]) => c[0] === 'journalctl');
    expect(logsCall).toBeDefined();
    expect(logsCall[1]).toContain('discoclaw-beta');
  });

  it('custom serviceName threads into systemctl restart args and reply string', async () => {
    const { execFile } = await import('node:child_process');
    const result = await handleRestartCommand({ action: 'restart' }, { serviceName: 'discoclaw-beta' });
    expect(result.reply).toBe('Restarting discoclaw-beta... back in a moment.');
    result.deferred!();
    const calls = (execFile as any).mock.calls;
    const restartCall = calls.find((c: any[]) => c[0] === 'systemctl' && c[1].includes('restart'));
    expect(restartCall).toBeDefined();
    expect(restartCall[1]).toContain('discoclaw-beta');
  });
});

describe('handleRestartCommand - custom serviceName (macOS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(process as any, 'getuid').mockReturnValue(501);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it('custom serviceName threads into launchctl label and plist path', async () => {
    const { execFile } = await import('node:child_process');
    const result = await handleRestartCommand({ action: 'restart' }, { serviceName: 'discoclaw-beta' });
    expect(result.reply).toBe('Restarting discoclaw-beta... back in a moment.');
    result.deferred!();
    const calls = (execFile as any).mock.calls;
    const kickstartCall = calls.find(
      (c: any[]) => c[0] === 'launchctl' && c[1].includes('kickstart'),
    );
    expect(kickstartCall).toBeDefined();
    expect(kickstartCall[1]).toContain('gui/501/com.discoclaw.discoclaw-beta');
  });

  it('custom serviceName uses correct plist path on bootstrap', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementationOnce(
      (cmd: string, args: string[], opts: any, cb: any) => {
        const err = Object.assign(new Error('not loaded'), { code: 1 });
        cb(err, '', '');
      },
    );
    const result = await handleRestartCommand({ action: 'restart' }, { serviceName: 'discoclaw-beta' });
    expect(result.reply).toBe('Starting discoclaw-beta...');
    result.deferred!();
    const calls = (execFile as any).mock.calls;
    const bootstrapCall = calls.find(
      (c: any[]) => c[0] === 'launchctl' && c[1].includes('bootstrap'),
    );
    expect(bootstrapCall).toBeDefined();
    expect(bootstrapCall[1]).toContain(
      '/Users/testuser/Library/LaunchAgents/com.discoclaw.discoclaw-beta.plist',
    );
  });

  it('custom serviceName threads into launchctl list (status)', async () => {
    const { execFile } = await import('node:child_process');
    await handleRestartCommand({ action: 'status' }, { serviceName: 'discoclaw-beta' });
    const calls = (execFile as any).mock.calls;
    const listCall = calls.find((c: any[]) => c[0] === 'launchctl' && c[1].includes('list'));
    expect(listCall).toBeDefined();
    expect(listCall[1]).toContain('com.discoclaw.discoclaw-beta');
  });
});

describe('handleRestartCommand - unsupported platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('restart returns explicit error message', async () => {
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toContain('!restart is not supported on this platform (win32)');
    expect(result.reply).toContain('Only Linux (systemd) and macOS (launchd) are supported.');
    expect(result.deferred).toBeUndefined();
  });

  it('status returns explicit error message', async () => {
    const result = await handleRestartCommand({ action: 'status' });
    expect(result.reply).toContain('!restart is not supported on this platform (win32)');
    expect(result.reply).toContain('Only Linux (systemd) and macOS (launchd) are supported.');
  });
});
