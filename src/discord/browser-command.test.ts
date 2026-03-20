import { describe, expect, it, vi } from 'vitest';
import type { BrowserCliReport } from '../cli/index.js';
import {
  handleBrowserCommand,
  parseBrowserCommand,
  renderBrowserDoctorReport,
  renderBrowserHelp,
  renderBrowserLaunchGuidance,
  renderBrowserSetupReport,
} from './browser-command.js';

function makeReport(overrides: Partial<BrowserCliReport> = {}): BrowserCliReport {
  return {
    ok: true,
    summary: 'Managed browser doctor found no blockers.',
    installMode: 'source',
    storageRule: 'Repo-local source installs may only use the default data/browser path.',
    executablePath: '/usr/bin/chromium',
    paths: {
      dataDir: '/repo/data/browser',
      profileDir: '/repo/data/browser/profile',
      stateFile: '/repo/data/browser/state.json',
    },
    issues: [],
    nextSteps: ['Run `discoclaw browser launch` to open the managed profile for login.'],
    ...overrides,
  };
}

describe('parseBrowserCommand', () => {
  it('returns null for unrelated input', () => {
    expect(parseBrowserCommand('')).toBeNull();
    expect(parseBrowserCommand('hello')).toBeNull();
    expect(parseBrowserCommand('!browsering')).toBeNull();
  });

  it('defaults bare !browser to help', () => {
    expect(parseBrowserCommand('!browser')).toEqual({ action: 'help' });
  });

  it('parses help, setup, and doctor case-insensitively', () => {
    expect(parseBrowserCommand('  !BROWSER help  ')).toEqual({ action: 'help' });
    expect(parseBrowserCommand('!browser setup')).toEqual({ action: 'setup' });
    expect(parseBrowserCommand('!browser DOCTOR')).toEqual({ action: 'doctor' });
  });

  it('parses headed and headless launch variants', () => {
    expect(parseBrowserCommand('!browser launch')).toEqual({ action: 'launch', headless: false });
    expect(parseBrowserCommand('!browser launch --headless')).toEqual({ action: 'launch', headless: true });
    expect(parseBrowserCommand('!browser launch headless')).toEqual({ action: 'launch', headless: true });
  });

  it('rejects unsupported extra arguments', () => {
    expect(parseBrowserCommand('!browser launch now')).toBeNull();
    expect(parseBrowserCommand('!browser setup please')).toBeNull();
    expect(parseBrowserCommand('!browser foo')).toBeNull();
  });
});

describe('renderBrowserHelp', () => {
  it('lists the managed browser commands', () => {
    const result = renderBrowserHelp();
    expect(result).toContain('!browser setup');
    expect(result).toContain('!browser doctor');
    expect(result).toContain('!browser launch');
    expect(result).toContain('!browser launch --headless');
  });
});

describe('renderBrowserSetupReport', () => {
  it('explains the managed-profile flow without a helper daemon', () => {
    const result = renderBrowserSetupReport(
      makeReport({
        summary: 'Managed browser profile is set up.',
        nextSteps: ['Launch headed once, log in, then close the browser.'],
      }),
    );

    expect(result).toContain('Managed browser setup');
    expect(result).toContain('No helper daemon or localhost control service is used.');
    expect(result).toContain('`discoclaw browser launch`');
    expect(result).toContain('`/repo/data/browser/profile`');
  });
});

describe('renderBrowserDoctorReport', () => {
  it('summarizes readiness and current lock/storage blockers', () => {
    const result = renderBrowserDoctorReport(
      makeReport({
        ok: false,
        summary: 'Managed browser doctor found blockers.',
        issues: [
          {
            code: 'storage_rejected',
            severity: 'error',
            message: 'Custom in-repo DISCOCLAW_DATA_DIR values are rejected for managed browser storage.',
            recommendation: 'Move DISCOCLAW_DATA_DIR outside the repo or use the default data/browser path.',
          },
          {
            code: 'profile_locked',
            severity: 'warn',
            message: 'The managed browser profile currently appears to be locked.',
            recommendation: 'If this is not the verified managed browser, close it before launching again.',
          },
        ],
      }),
    );

    expect(result).toContain('Readiness: blocked');
    expect(result).toContain('Current state: managed profile appears to be locked by another browser process');
    expect(result).toContain('Storage rule: Repo-local source installs may only use the default data/browser path.');
    expect(result).toContain('[ERROR] Custom in-repo DISCOCLAW_DATA_DIR values are rejected for managed browser storage.');
    expect(result).toContain('[WARN] The managed browser profile currently appears to be locked.');
  });
});

describe('renderBrowserLaunchGuidance', () => {
  it('prints the exact local headed launch command and current blockers', () => {
    const result = renderBrowserLaunchGuidance(
      makeReport({
        issues: [
          {
            code: 'profile_locked',
            severity: 'error',
            message: 'The managed browser profile is already open, but no verified managed instance could be reused.',
            recommendation: 'Close the managed browser first, then rerun `discoclaw browser launch`.',
          },
        ],
      }),
    );

    expect(result).toContain('Discord does not launch the browser for you.');
    expect(result).toContain('```bash\ndiscoclaw browser launch\n```');
    expect(result).toContain('Managed profile dir: `/repo/data/browser/profile`');
    expect(result).toContain('Alternate launch: `discoclaw browser launch --headless`');
    expect(result).toContain('Blockers:');
    expect(result).toContain('Close the managed browser first, then rerun `discoclaw browser launch`.');
  });

  it('prints the exact local headless launch command when requested', () => {
    const result = renderBrowserLaunchGuidance(makeReport(), { headless: true });

    expect(result).toContain('```bash\ndiscoclaw browser launch --headless\n```');
    expect(result).toContain('Headed login command: `discoclaw browser launch`');
  });
});

describe('handleBrowserCommand', () => {
  it('uses setup for setup and doctor for launch guidance instead of launching through Discord', async () => {
    const setup = vi.fn(async () => makeReport({
      summary: 'Managed browser profile is set up.',
    }));
    const doctor = vi.fn(async () => makeReport({
      issues: [
        {
          code: 'profile_locked',
          severity: 'error',
          message: 'The managed browser profile is already open, but no verified managed instance could be reused.',
        },
      ],
    }));

    const setupResult = await handleBrowserCommand(
      { action: 'setup' },
      { cwd: '/repo', env: {} },
      { setup, doctor },
    );
    const launchResult = await handleBrowserCommand(
      { action: 'launch', headless: false },
      { cwd: '/repo', env: {} },
      { setup, doctor },
    );

    expect(setup).toHaveBeenCalledWith({ cwd: '/repo', env: {} });
    expect(doctor).toHaveBeenCalledWith({ cwd: '/repo', env: {} });
    expect(setupResult).toContain('Managed browser setup');
    expect(launchResult).toContain('discoclaw browser launch');
    expect(launchResult).toContain('The managed browser profile is already open, but no verified managed instance could be reused.');
  });
});
