import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  parseEnvFile,
  renderSystemdUnit,
  renderLaunchdPlist,
  runDaemonInstaller,
} from './daemon-installer.js';

// ── Test helpers ───────────────────────────────────────────────────────────

function makeReadline(answers: string[] = []) {
  return {
    question: vi.fn(async () => answers.shift() ?? ''),
    close: vi.fn(),
    on: vi.fn(),
  };
}

const PACKAGE_ROOT = '/opt/discoclaw';
const CWD = '/home/user/bot';
const SAMPLE_ENV = 'DISCORD_TOKEN=abc123\nDISCORD_ALLOW_USER_IDS=111\n# comment\n\nFOO=bar=baz\n';

// ── parseEnvFile ───────────────────────────────────────────────────────────

describe('parseEnvFile', () => {
  it('parses key=value pairs', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines and comment lines', () => {
    const result = parseEnvFile('# comment\n\nFOO=bar\n');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('preserves values that contain = characters', () => {
    const result = parseEnvFile('FOO=bar=baz\n');
    expect(result).toEqual({ FOO: 'bar=baz' });
  });

  it('returns empty object for empty input', () => {
    expect(parseEnvFile('')).toEqual({});
    expect(parseEnvFile('# just comments\n')).toEqual({});
  });
});

// ── renderSystemdUnit ──────────────────────────────────────────────────────

describe('renderSystemdUnit', () => {
  it('produces correct ExecStart with /usr/bin/node and dist/index.js', () => {
    const unit = renderSystemdUnit(PACKAGE_ROOT, CWD);
    expect(unit).toContain(`ExecStart=/usr/bin/node ${PACKAGE_ROOT}/dist/index.js`);
  });

  it('sets WorkingDirectory to the provided cwd', () => {
    const unit = renderSystemdUnit(PACKAGE_ROOT, CWD);
    expect(unit).toContain(`WorkingDirectory=${CWD}`);
  });

  it('sets EnvironmentFile to <cwd>/.env', () => {
    const unit = renderSystemdUnit(PACKAGE_ROOT, CWD);
    expect(unit).toContain(`EnvironmentFile=${CWD}/.env`);
  });

  it('includes standard unit and install sections', () => {
    const unit = renderSystemdUnit(PACKAGE_ROOT, CWD);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
});

// ── renderLaunchdPlist ─────────────────────────────────────────────────────

describe('renderLaunchdPlist', () => {
  const envVars = { DISCORD_TOKEN: 'tok', FOO: 'bar' };

  it('produces valid XML plist with correct label', () => {
    const plist = renderLaunchdPlist(PACKAGE_ROOT, CWD, envVars);
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<string>com.discoclaw.agent</string>');
  });

  it('sets ProgramArguments to /usr/bin/node and dist/index.js', () => {
    const plist = renderLaunchdPlist(PACKAGE_ROOT, CWD, envVars);
    expect(plist).toContain('<string>/usr/bin/node</string>');
    expect(plist).toContain(`<string>${PACKAGE_ROOT}/dist/index.js</string>`);
  });

  it('sets WorkingDirectory to the provided cwd', () => {
    const plist = renderLaunchdPlist(PACKAGE_ROOT, CWD, envVars);
    expect(plist).toContain(`<string>${CWD}</string>`);
  });

  it('emits EnvironmentVariables entries for each parsed .env key', () => {
    const plist = renderLaunchdPlist(PACKAGE_ROOT, CWD, envVars);
    expect(plist).toContain('<key>DISCORD_TOKEN</key>');
    expect(plist).toContain('<string>tok</string>');
    expect(plist).toContain('<key>FOO</key>');
    expect(plist).toContain('<string>bar</string>');
  });

  it('includes RunAtLoad and KeepAlive', () => {
    const plist = renderLaunchdPlist(PACKAGE_ROOT, CWD, envVars);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');
  });
});

// ── runDaemonInstaller ─────────────────────────────────────────────────────

const originalIsTTY = (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
const originalPlatform = process.platform;

describe('runDaemonInstaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = true;
    // Default: .env and dist/index.js exist; service file does not
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('.env')) return true;
      if (s.endsWith('dist/index.js')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(SAMPLE_ENV as any);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execFileSync).mockReturnValue(Buffer.alloc(0));
    vi.mocked(createInterface).mockReturnValue(makeReadline() as any);
    // Default to linux for most tests
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = originalIsTTY;
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  // ── Guard checks ──────────────────────────────────────────────────────────

  it('errors when stdin is not a TTY', async () => {
    (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY = false;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(runDaemonInstaller()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('requires an interactive terminal'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors when .env is missing in cwd', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(runDaemonInstaller()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('discoclaw init'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors when dist/index.js does not exist at package root', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('.env')) return true;
      return false; // dist/index.js missing
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(runDaemonInstaller()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('dist/index.js'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors on unsupported platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(runDaemonInstaller()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Unsupported platform'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Platform routing ──────────────────────────────────────────────────────

  it('linux: calls systemctl daemon-reload then enable --now', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await runDaemonInstaller();

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls).toContainEqual(['systemctl', ['--user', 'daemon-reload']]);
    expect(calls).toContainEqual(['systemctl', ['--user', 'enable', '--now', 'discoclaw']]);
    expect(calls.some(([cmd]) => cmd === 'launchctl')).toBe(false);
  });

  it('darwin: calls launchctl bootout then bootstrap', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    await runDaemonInstaller();

    const calls = vi.mocked(execFileSync).mock.calls;
    const launchctlCalls = calls.filter(([cmd]) => cmd === 'launchctl');
    expect(launchctlCalls.length).toBeGreaterThanOrEqual(2);
    const [bootoutArgs] = launchctlCalls[0]!.slice(1) as [string[]];
    const [bootstrapArgs] = launchctlCalls[1]!.slice(1) as [string[]];
    expect(bootoutArgs[0]).toBe('bootout');
    expect(bootstrapArgs[0]).toBe('bootstrap');
    expect(calls.some(([cmd]) => cmd === 'systemctl')).toBe(false);
  });

  // ── Failure handling ──────────────────────────────────────────────────────

  it('systemctl enable failure produces a clear error message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'systemctl' && argsArr.includes('enable')) {
        throw new Error('Failed to enable unit');
      }
      return Buffer.alloc(0);
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(runDaemonInstaller()).rejects.toThrow('exit:1');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('systemctl enable/start failed'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('launchctl bootout failure is ignored; bootstrap failure produces a clear error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    let bootoutCalled = false;
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (cmd === 'launchctl' && argsArr[0] === 'bootout') {
        bootoutCalled = true;
        // bootout "succeeds" (no throw) — idempotent unload
        return Buffer.alloc(0);
      }
      if (cmd === 'launchctl' && argsArr[0] === 'bootstrap') {
        throw new Error('bootstrap: service already exists');
      }
      return Buffer.alloc(0);
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(runDaemonInstaller()).rejects.toThrow('exit:1');
    expect(bootoutCalled).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('launchctl bootstrap failed'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Overwrite prompts ─────────────────────────────────────────────────────

  it('linux: prompts before overwriting an existing service file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    // Service file exists
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('.env')) return true;
      if (s.endsWith('dist/index.js')) return true;
      if (s.endsWith('discoclaw.service')) return true;
      return false;
    });

    const rl = makeReadline(['y']); // answer 'y' to overwrite prompt
    vi.mocked(createInterface).mockReturnValue(rl as any);

    await runDaemonInstaller();

    expect(rl.question).toHaveBeenCalledWith(expect.stringContaining('Overwrite?'));
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('linux: aborts if user declines to overwrite existing service file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('.env')) return true;
      if (s.endsWith('dist/index.js')) return true;
      if (s.endsWith('discoclaw.service')) return true;
      return false;
    });

    const rl = makeReadline(['n']); // decline overwrite
    vi.mocked(createInterface).mockReturnValue(rl as any);

    await runDaemonInstaller();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
