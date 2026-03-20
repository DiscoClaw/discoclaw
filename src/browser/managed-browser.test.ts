import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildManagedBrowserLaunchArgs,
  discoverManagedBrowserExecutable,
  enforceManagedBrowserStorageRule,
  launchManagedBrowser,
  resolveManagedBrowserPaths,
  saveManagedBrowserState,
  verifyManagedBrowserCdp,
  type ManagedBrowserDeps,
  type ManagedBrowserState,
} from './managed-browser.js';

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'managed-browser-'));
}

function makeChildProcess(pid = 4242): ChildProcess {
  return {
    pid,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  } as unknown as ChildProcess;
}

function makeAdvancingNow(start = Date.UTC(2026, 2, 20, 12, 0, 0)): () => Date {
  let current = start;
  return () => {
    const value = new Date(current);
    current += 1_000;
    return value;
  };
}

function makeDeps(overrides: Partial<ManagedBrowserDeps> = {}): ManagedBrowserDeps {
  return {
    existsSync: vi.fn(() => true),
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: fs.rename,
    unlink: fs.unlink,
    access: fs.access,
    findOnPath: vi.fn(async (command: string) => command === 'chromium' ? '/usr/bin/chromium' : null),
    spawnBrowser: vi.fn(() => makeChildProcess()),
    httpGetJson: vi.fn(async () => ({
      Browser: 'Chrome/136.0.0.0',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/fresh',
    })),
    websocketProbe: vi.fn(async () => ({
      browser: 'Chrome/136.0.0.0',
      protocolVersion: '1.3',
    })),
    isPidAlive: vi.fn(() => true),
    isPortAvailable: vi.fn(async () => true),
    chooseFreePort: vi.fn(async () => 9555),
    sleep: vi.fn(async () => undefined),
    killPid: vi.fn(),
    now: makeAdvancingNow(),
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

describe('resolveManagedBrowserPaths', () => {
  it('resolves managed browser paths under the configured data dir', () => {
    const paths = resolveManagedBrowserPaths('/var/lib/discoclaw', '/repo');
    expect(paths).toEqual({
      dataDir: path.join('/var/lib/discoclaw', 'browser'),
      profileDir: path.join('/var/lib/discoclaw', 'browser', 'profile'),
      stateFile: path.join('/var/lib/discoclaw', 'browser', 'state.json'),
    });
  });

  it('falls back to the repo data/browser path when no data dir is configured', () => {
    const paths = resolveManagedBrowserPaths('', '/repo');
    expect(paths.dataDir).toBe(path.join('/repo', 'data', 'browser'));
  });
});

describe('enforceManagedBrowserStorageRule', () => {
  it('rejects in-repo custom data dirs for source installs', () => {
    const result = enforceManagedBrowserStorageRule({
      cwd: '/repo',
      dataDir: './custom-data',
      installMode: 'source',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue.code).toBe('storage_rejected');
      expect(result.paths.dataDir).toBe(path.join('/repo', 'custom-data', 'browser'));
    }
  });

  it('allows the default repo data/browser path for source installs', () => {
    const result = enforceManagedBrowserStorageRule({
      cwd: '/repo',
      dataDir: './data',
      installMode: 'source',
    });

    expect(result.ok).toBe(true);
    expect(result.paths.dataDir).toBe(path.join('/repo', 'data', 'browser'));
  });
});

describe('discoverManagedBrowserExecutable', () => {
  it('prefers AGENT_BROWSER_EXECUTABLE_PATH over PATH discovery', async () => {
    const access = vi.fn(async (targetPath: Parameters<typeof fs.access>[0]) => {
      if (String(targetPath) === '/opt/chrome/chrome') return;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const findOnPath = vi.fn(async () => '/usr/bin/chromium');

    const result = await discoverManagedBrowserExecutable(
      { AGENT_BROWSER_EXECUTABLE_PATH: '/opt/chrome/chrome' },
      '/repo',
      { access, findOnPath },
    );

    expect(result.executablePath).toBe('/opt/chrome/chrome');
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it('falls back to PATH candidates when no configured executable is set', async () => {
    const result = await discoverManagedBrowserExecutable(
      {},
      '/repo',
      {
        access: vi.fn(async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }),
        findOnPath: vi.fn(async (command: string) => command === 'chromium' ? '/usr/bin/chromium' : null),
      },
    );

    expect(result.executablePath).toBe('/usr/bin/chromium');
  });
});

describe('buildManagedBrowserLaunchArgs', () => {
  it('builds headed launch args with the managed profile and debug port', () => {
    const args = buildManagedBrowserLaunchArgs({
      profileDir: '/repo/data/browser/profile',
      port: 9222,
      headless: false,
    });

    expect(args).toContain('--new-window');
    expect(args).toContain('--user-data-dir=/repo/data/browser/profile');
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).not.toContain('--headless=new');
  });

  it('adds the headless flag for headless launches', () => {
    const args = buildManagedBrowserLaunchArgs({
      profileDir: '/repo/data/browser/profile',
      port: 9333,
      headless: true,
    });

    expect(args).toContain('--headless=new');
    expect(args).not.toContain('--new-window');
  });
});

describe('verifyManagedBrowserCdp', () => {
  it('accepts a loopback browser websocket from /json/version on the same port', async () => {
    const deps = makeDeps({
      httpGetJson: vi.fn(async () => ({
        Browser: 'Chrome/136.0.0.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/reuse',
      })),
    });

    const result = await verifyManagedBrowserCdp({
      pid: 2222,
      port: 9222,
    }, deps);

    expect(result).toMatchObject({
      pid: 2222,
      port: 9222,
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/reuse',
    });
    expect(deps.websocketProbe).toHaveBeenCalledWith(
      'ws://127.0.0.1:9222/devtools/browser/reuse',
      1_500,
    );
  });

  it('rejects /json/version payloads that hand off to a different websocket endpoint', async () => {
    const deps = makeDeps({
      httpGetJson: vi.fn(async () => ({
        Browser: 'Chrome/136.0.0.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/other-port',
      })),
    });

    const result = await verifyManagedBrowserCdp({
      pid: 2222,
      port: 9222,
    }, deps);

    expect(result).toBeNull();
    expect(deps.websocketProbe).not.toHaveBeenCalled();
  });
});

describe('launchManagedBrowser', () => {
  it('reuses a previously verified managed instance', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });
    await saveManagedBrowserState(paths.stateFile, {
      pid: 2222,
      port: 9222,
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/reuse',
      profileDir: paths.profileDir,
      executablePath: '/usr/bin/chromium',
      launchedAt: '2026-03-20T12:00:00.000Z',
      headless: false,
    });

    const deps = makeDeps({
      httpGetJson: vi.fn(async () => ({
        Browser: 'Chrome/136.0.0.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/reuse',
      })),
    });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: false,
    }, deps);

    expect(report.ok).toBe(true);
    expect(report.launch).toMatchObject({
      reusedExisting: true,
      pid: 2222,
      port: 9222,
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/reuse',
    });
    expect(deps.spawnBrowser).not.toHaveBeenCalled();
  });

  it('fails fast when the profile is locked but no verified managed instance can be reused', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });
    await saveManagedBrowserState(paths.stateFile, {
      pid: 3333,
      port: 9222,
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/stale',
      profileDir: paths.profileDir,
      executablePath: '/usr/bin/chromium',
      launchedAt: '2026-03-20T12:00:00.000Z',
      headless: false,
    });
    await fs.writeFile(path.join(paths.profileDir, 'SingletonLock'), '', 'utf-8');

    const deps = makeDeps({
      httpGetJson: vi.fn(async () => ({
        Browser: 'Chrome/136.0.0.0',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
      })),
    });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: false,
    }, deps);

    expect(report.ok).toBe(false);
    expect(report.summary).toBe('Managed browser profile is locked by another process.');
    expect(report.issues?.map((issue) => issue.code)).toContain('profile_locked');
    await expect(fs.access(paths.stateFile)).rejects.toThrow();
    expect(deps.spawnBrowser).not.toHaveBeenCalled();
  });

  it('cleans up stale launcher state before writing verified fresh state', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });
    await fs.writeFile(paths.stateFile, '{not-json', 'utf-8');

    const spawnBrowser = vi.fn(() => makeChildProcess(4444));
    const deps = makeDeps({ spawnBrowser });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: false,
    }, deps);

    expect(report.ok).toBe(true);
    expect(spawnBrowser).toHaveBeenCalledOnce();
    const persisted = JSON.parse(await fs.readFile(paths.stateFile, 'utf-8')) as ManagedBrowserState;
    expect(persisted.pid).toBe(4444);
    expect(persisted.cdpUrl).toBe('ws://127.0.0.1:9555/devtools/browser/fresh');
  });

  it('returns a structured failure when stale launcher state cannot be removed before relaunch', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });
    await fs.writeFile(paths.stateFile, '{not-json', 'utf-8');

    const spawnBrowser = vi.fn(() => makeChildProcess(4444));
    const deps = makeDeps({
      spawnBrowser,
      unlink: vi.fn(async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }),
    });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: false,
    }, deps);

    expect(report.ok).toBe(false);
    expect(report.summary).toBe('Managed browser launch could not clear stale launcher state.');
    expect(report.issues?.map((issue) => issue.code)).toContain('stale_launcher_state_cleanup_failed');
    expect(report.issues?.[0]?.detail).toContain(paths.stateFile);
    expect(spawnBrowser).not.toHaveBeenCalled();
  });

  it('chooses a fresh free port when stored state is stale', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });
    await saveManagedBrowserState(paths.stateFile, {
      pid: 5555,
      port: 9222,
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/stale',
      profileDir: paths.profileDir,
      executablePath: '/usr/bin/chromium',
      launchedAt: '2026-03-20T12:00:00.000Z',
      headless: false,
    });

    const spawnBrowser = vi.fn(() => makeChildProcess(6666));
    const chooseFreePort = vi.fn(async () => 9777);
    const deps = makeDeps({
      spawnBrowser,
      chooseFreePort,
      isPortAvailable: vi.fn(async () => false),
      httpGetJson: vi
        .fn()
        .mockResolvedValueOnce({
          Browser: 'Chrome/136.0.0.0',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/changed',
        })
        .mockResolvedValue({
          Browser: 'Chrome/136.0.0.0',
          'Protocol-Version': '1.3',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9777/devtools/browser/fresh',
        }),
    });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: true,
    }, deps);

    expect(report.ok).toBe(true);
    expect(chooseFreePort).toHaveBeenCalledOnce();
    expect(spawnBrowser).toHaveBeenCalledWith(
      '/usr/bin/chromium',
      expect.arrayContaining(['--remote-debugging-port=9777', '--headless=new']),
    );
    expect(report.launch?.port).toBe(9777);
  });

  it('rolls back tentative launcher state when post-spawn verification fails', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });

    const killPid = vi.fn();
    const isPidAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const deps = makeDeps({
      spawnBrowser: vi.fn(() => makeChildProcess(7777)),
      killPid,
      isPidAlive,
      httpGetJson: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: true,
    }, deps);

    expect(report.ok).toBe(false);
    expect(report.issues?.map((issue) => issue.code)).toContain('verification_failed');
    expect(killPid).toHaveBeenCalledWith(7777);
    await expect(fs.access(paths.stateFile)).rejects.toThrow();
  });

  it('keeps tentative launcher state when browser termination cannot be confirmed after verification failure', async () => {
    const cwd = await makeTempDir();
    tempDirs.push(cwd);
    const paths = resolveManagedBrowserPaths(undefined, cwd);
    await fs.mkdir(paths.profileDir, { recursive: true });

    const killPid = vi.fn();
    const deps = makeDeps({
      spawnBrowser: vi.fn(() => makeChildProcess(8888)),
      killPid,
      isPidAlive: vi.fn(() => true),
      httpGetJson: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });

    const report = await launchManagedBrowser({
      cwd,
      env: {},
      headless: true,
    }, deps);

    expect(report.ok).toBe(false);
    expect(report.issues?.map((issue) => issue.code)).toContain('verification_termination_unconfirmed');
    expect(killPid).toHaveBeenCalledWith(8888);
    const persisted = JSON.parse(await fs.readFile(paths.stateFile, 'utf-8')) as ManagedBrowserState;
    expect(persisted.pid).toBe(8888);
    expect(persisted.cdpUrl).toBeUndefined();
  });
});
