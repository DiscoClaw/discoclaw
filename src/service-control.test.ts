import { describe, expect, it, vi } from 'vitest';
import {
  getServiceCommands,
  normalizeServiceName,
  probeServiceSummary,
  runServiceAction,
  summarizeServiceStatus,
  truncateCommandOutput,
  type CommandResult,
  type ServiceControlDeps,
} from './service-control.js';

function makeResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ServiceControlDeps> = {}): ServiceControlDeps {
  return {
    runCommand: vi.fn(async () => makeResult()),
    platform: 'linux',
    homeDir: '/Users/david',
    getUid: () => 501,
    ...overrides,
  };
}

describe('normalizeServiceName', () => {
  it('falls back to discoclaw when the env value is blank', () => {
    expect(normalizeServiceName(undefined)).toBe('discoclaw');
    expect(normalizeServiceName('   ')).toBe('discoclaw');
    expect(normalizeServiceName(' discoclaw-beta ')).toBe('discoclaw-beta');
  });
});

describe('getServiceCommands', () => {
  it('builds linux systemd commands with the provided service name', () => {
    const commands = getServiceCommands('discoclaw-beta', 'linux', '/Users/david', 501);
    expect(commands?.statusCmd).toEqual(['systemctl', ['--user', 'status', 'discoclaw-beta']]);
    expect(commands?.logsCmd).toEqual(['journalctl', ['--user', '-u', 'discoclaw-beta', '--no-pager', '-n', '30']]);
  });

  it('builds macOS launchctl commands and bootstraps when inactive', () => {
    const commands = getServiceCommands('discoclaw-beta', 'darwin', '/Users/david', 502);
    expect(commands?.restartCmd(false)).toEqual([
      'launchctl',
      [
        'bootstrap',
        'gui/502',
        '/Users/david/Library/LaunchAgents/com.discoclaw.discoclaw-beta.plist',
      ],
    ]);
  });
});

describe('summarizeServiceStatus', () => {
  it('extracts the active line from linux status output', () => {
    expect(summarizeServiceStatus(
      makeResult({ stdout: 'Loaded: loaded\n   Active: active (running) since today\nMain PID: 1\n' }),
      'linux',
    )).toBe('active (running) since today');
  });

  it('falls back to the first non-empty line on other platforms', () => {
    expect(summarizeServiceStatus(makeResult({ stdout: '\n123\t0\tcom.discoclaw.discoclaw\n' }), 'darwin'))
      .toBe('123\t0\tcom.discoclaw.discoclaw');
  });
});

describe('truncateCommandOutput', () => {
  it('returns a placeholder for empty output and truncates long output', () => {
    expect(truncateCommandOutput('   ')).toBe('(no output)');
    expect(truncateCommandOutput('abcdef', 5)).toContain('[output truncated]');
  });
});

describe('probeServiceSummary', () => {
  it('returns the summarized status detail', async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => makeResult({
        stdout: 'Loaded: loaded\n   Active: active (running) since today\n',
      })),
    });

    await expect(probeServiceSummary('discoclaw-beta', deps)).resolves.toBe('active (running) since today');
  });
});

describe('runServiceAction', () => {
  it('returns status output for status actions', async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => makeResult({ stdout: '   Active: active (running)\n' })),
    });

    await expect(runServiceAction('status', 'discoclaw-beta', deps)).resolves.toBe('Active: active (running)');
  });

  it('requests a restart when the service is already active', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(makeResult({ stdout: '   Active: active (running)\n' }))
      .mockResolvedValueOnce(makeResult({ stdout: 'done\n' }));
    const deps = makeDeps({ runCommand });

    await expect(runServiceAction('restart', 'discoclaw-beta', deps)).resolves.toBe(
      'Restart requested for discoclaw-beta.\n\ndone',
    );
    expect(runCommand).toHaveBeenNthCalledWith(2, 'systemctl', ['--user', 'restart', 'discoclaw-beta']);
  });

  it('bootstraps an inactive macOS service instead of kickstarting it', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(makeResult({ exitCode: 1 }))
      .mockResolvedValueOnce(makeResult({ stdout: 'bootstrapped\n' }));
    const deps = makeDeps({
      runCommand,
      platform: 'darwin',
      homeDir: '/Users/david',
      getUid: () => 502,
    });

    await expect(runServiceAction('restart', 'discoclaw-beta', deps)).resolves.toBe(
      'Start requested for discoclaw-beta.\n\nbootstrapped',
    );
    expect(runCommand).toHaveBeenNthCalledWith(2, 'launchctl', [
      'bootstrap',
      'gui/502',
      '/Users/david/Library/LaunchAgents/com.discoclaw.discoclaw-beta.plist',
    ]);
  });
});
