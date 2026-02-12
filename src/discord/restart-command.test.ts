import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseRestartCommand, handleRestartCommand } from './restart-command.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    // Simulate systemctl status returning "active (running)"
    if (args.includes('status')) {
      cb(null, 'active (running)\n', '');
    } else if (args.includes('restart')) {
      cb(null, '', '');
    } else {
      // journalctl logs
      cb(null, 'Feb 12 14:00:00 discoclaw[1234]: started\n', '');
    }
  }),
}));

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

  it('restart reports "Starting" when service was not active', async () => {
    const { execFile } = await import('node:child_process');
    // Override mock to simulate inactive service
    (execFile as any).mockImplementation(
      (cmd: string, args: string[], opts: any, cb: any) => {
        cb(null, 'inactive (dead)\n', '');
      },
    );
    const result = await handleRestartCommand({ action: 'restart' });
    expect(result.reply).toBe('Starting discoclaw...');
  });
});
