import fs from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { execa } from 'execa';
import WebSocket from 'ws';
import type { BrowserCliCommandOptions, BrowserCliIssue, BrowserCliReport } from '../cli/index.js';

export type InstallMode = 'source' | 'npm-managed';

export type ManagedBrowserPaths = {
  dataDir: string;
  profileDir: string;
  stateFile: string;
};

export type ManagedBrowserState = {
  pid: number;
  port: number;
  profileDir: string;
  executablePath: string;
  launchedAt: string;
  headless: boolean;
  cdpUrl?: string;
};

export type ManagedBrowserVerification = {
  pid: number;
  port: number;
  cdpUrl: string;
  browser?: string;
  protocolVersion?: string;
};

export type ManagedBrowserLaunchArgs = {
  profileDir: string;
  port: number;
  headless: boolean;
};

export type ManagedBrowserDeps = {
  existsSync: typeof existsSync;
  mkdir: typeof fs.mkdir;
  readFile: typeof fs.readFile;
  writeFile: typeof fs.writeFile;
  rename: typeof fs.rename;
  unlink: typeof fs.unlink;
  access: typeof fs.access;
  findOnPath: (command: string) => Promise<string | null>;
  spawnBrowser: (executablePath: string, args: string[]) => ChildProcess;
  httpGetJson: (url: string, timeoutMs: number) => Promise<unknown>;
  websocketProbe: (cdpUrl: string, timeoutMs: number) => Promise<{ browser?: string; protocolVersion?: string }>;
  isPidAlive: (pid: number) => boolean;
  isPortAvailable: (port: number) => Promise<boolean>;
  chooseFreePort: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  killPid: (pid: number) => void;
  now: () => Date;
};

type ManagedBrowserReadStateResult = {
  exists: boolean;
  state: ManagedBrowserState | null;
};

type ManagedBrowserInspection = {
  installMode: InstallMode;
  storageRule: string;
  paths: ManagedBrowserPaths;
  defaultPaths: ManagedBrowserPaths;
  executablePath: string | null;
  issues: BrowserCliIssue[];
};

const STORAGE_RULE = 'Repo-local source installs may only use the default data/browser path.';
const CDP_HOST = '127.0.0.1';
const HTTP_VERIFY_TIMEOUT_MS = 1_500;
const WS_VERIFY_TIMEOUT_MS = 1_500;
const POST_SPAWN_VERIFY_TIMEOUT_MS = 10_000;
const POST_SPAWN_VERIFY_POLL_MS = 200;
const POST_TERMINATION_VERIFY_TIMEOUT_MS = 2_000;
const POST_TERMINATION_VERIFY_POLL_MS = 100;
const PROFILE_LOCK_FILES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
] as const;
const PATH_EXECUTABLE_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
] as const;
const ABSOLUTE_EXECUTABLE_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
] as const;

const defaultDeps: ManagedBrowserDeps = {
  existsSync,
  mkdir: fs.mkdir,
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  rename: fs.rename,
  unlink: fs.unlink,
  access: fs.access,
  findOnPath: findExecutableOnPath,
  spawnBrowser: spawnManagedBrowserProcess,
  httpGetJson: httpGetJson,
  websocketProbe: websocketBrowserGetVersion,
  isPidAlive,
  isPortAvailable,
  chooseFreePort,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  killPid: (pid) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Best effort only.
    }
  },
  now: () => new Date(),
};

export function resolveManagedBrowserPaths(dataDir: string | undefined, projectRoot: string): ManagedBrowserPaths {
  const configured = (dataDir ?? '').trim();
  const baseDataDir = path.resolve(projectRoot, configured || 'data');
  const managedDataDir = path.join(baseDataDir, 'browser');
  return {
    dataDir: managedDataDir,
    profileDir: path.join(managedDataDir, 'profile'),
    stateFile: path.join(managedDataDir, 'state.json'),
  };
}

export function detectManagedBrowserInstallMode(
  cwd: string,
  deps: Pick<ManagedBrowserDeps, 'existsSync'> = defaultDeps,
): InstallMode {
  return deps.existsSync(path.join(cwd, '.git')) ? 'source' : 'npm-managed';
}

export function enforceManagedBrowserStorageRule(params: {
  cwd: string;
  dataDir?: string;
  installMode?: InstallMode;
  deps?: Pick<ManagedBrowserDeps, 'existsSync'>;
}): { ok: true; paths: ManagedBrowserPaths; installMode: InstallMode; storageRule: string } | {
  ok: false;
  paths: ManagedBrowserPaths;
  installMode: InstallMode;
  storageRule: string;
  issue: BrowserCliIssue;
} {
  const deps = params.deps ?? defaultDeps;
  const installMode = params.installMode ?? detectManagedBrowserInstallMode(params.cwd, deps);
  const paths = resolveManagedBrowserPaths(params.dataDir, params.cwd);
  const defaultPaths = resolveManagedBrowserPaths(undefined, params.cwd);
  const configured = (params.dataDir ?? '').trim();

  if (
    installMode === 'source' &&
    configured.length > 0 &&
    isPathWithin(params.cwd, paths.dataDir) &&
    normalizePath(paths.dataDir) !== normalizePath(defaultPaths.dataDir)
  ) {
    return {
      ok: false,
      installMode,
      storageRule: STORAGE_RULE,
      paths,
      issue: {
        code: 'storage_rejected',
        severity: 'error',
        message: 'Custom in-repo DISCOCLAW_DATA_DIR values are rejected for managed browser storage.',
        recommendation: 'Move DISCOCLAW_DATA_DIR outside the repo or use the default data/browser path.',
      },
    };
  }

  return {
    ok: true,
    installMode,
    storageRule: STORAGE_RULE,
    paths,
  };
}

export async function discoverManagedBrowserExecutable(
  env: NodeJS.ProcessEnv,
  cwd: string,
  deps: Pick<ManagedBrowserDeps, 'access' | 'findOnPath'> = defaultDeps,
): Promise<{ executablePath: string | null; issues: BrowserCliIssue[] }> {
  const issues: BrowserCliIssue[] = [];
  const configured = firstNonEmpty(env.DISCOCLAW_BROWSER_EXECUTABLE_PATH, env.AGENT_BROWSER_EXECUTABLE_PATH);

  if (configured) {
    const configuredPath = path.resolve(cwd, configured);
    if (await pathExists(configuredPath, deps.access)) {
      return { executablePath: configuredPath, issues };
    }
    issues.push({
      code: 'browser_executable_missing',
      severity: 'warn',
      message: `Configured browser executable was not found: ${configuredPath}`,
      recommendation: 'Fix AGENT_BROWSER_EXECUTABLE_PATH or install Chrome/Chromium on PATH.',
    });
  }

  for (const command of PATH_EXECUTABLE_CANDIDATES) {
    const found = await deps.findOnPath(command);
    if (found) return { executablePath: found, issues };
  }

  for (const candidate of ABSOLUTE_EXECUTABLE_CANDIDATES) {
    if (await pathExists(candidate, deps.access)) {
      return { executablePath: candidate, issues };
    }
  }

  issues.push({
    code: 'browser_not_found',
    severity: 'error',
    message: 'Chrome/Chromium executable could not be discovered.',
    recommendation: 'Install Chrome/Chromium or set AGENT_BROWSER_EXECUTABLE_PATH to a valid executable path.',
  });
  return { executablePath: null, issues };
}

export function buildManagedBrowserLaunchArgs(options: ManagedBrowserLaunchArgs): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    `--remote-debugging-address=${CDP_HOST}`,
    `--remote-debugging-port=${options.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints',
    ...(options.headless ? ['--headless=new'] : ['--new-window']),
    'about:blank',
  ];
}

export async function loadManagedBrowserState(
  filePath: string,
  deps: Pick<ManagedBrowserDeps, 'readFile'> = defaultDeps,
): Promise<ManagedBrowserState | null> {
  const { state } = await readManagedBrowserState(filePath, deps);
  return state;
}

export async function saveManagedBrowserState(
  filePath: string,
  state: ManagedBrowserState,
  deps: Pick<ManagedBrowserDeps, 'mkdir' | 'writeFile' | 'rename' | 'unlink'> = defaultDeps,
): Promise<void> {
  await deps.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    await deps.writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    await deps.rename(tmpPath, filePath);
  } catch (err) {
    await deps.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function clearManagedBrowserState(
  filePath: string,
  deps: Pick<ManagedBrowserDeps, 'unlink'> = defaultDeps,
): Promise<void> {
  try {
    await deps.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

export async function verifyManagedBrowserCdp(
  state: Pick<ManagedBrowserState, 'pid' | 'port'> & Partial<Pick<ManagedBrowserState, 'cdpUrl'>>,
  deps: Pick<ManagedBrowserDeps, 'isPidAlive' | 'httpGetJson' | 'websocketProbe'> = defaultDeps,
): Promise<ManagedBrowserVerification | null> {
  if (!deps.isPidAlive(state.pid)) return null;

  const versionUrl = `http://${CDP_HOST}:${state.port}/json/version`;
  let versionPayload: unknown;
  try {
    versionPayload = await deps.httpGetJson(versionUrl, HTTP_VERIFY_TIMEOUT_MS);
  } catch {
    return null;
  }

  const version = parseJsonVersionPayload(versionPayload, state.port);
  if (!version) return null;
  if (state.cdpUrl && version.cdpUrl !== state.cdpUrl) return null;

  let probe: { browser?: string; protocolVersion?: string };
  try {
    probe = await deps.websocketProbe(version.cdpUrl, WS_VERIFY_TIMEOUT_MS);
  } catch {
    return null;
  }

  return {
    pid: state.pid,
    port: state.port,
    cdpUrl: version.cdpUrl,
    browser: probe.browser ?? version.browser,
    protocolVersion: probe.protocolVersion ?? version.protocolVersion,
  };
}

export async function setupManagedBrowser(
  options: BrowserCliCommandOptions,
  deps: ManagedBrowserDeps = defaultDeps,
): Promise<BrowserCliReport> {
  const inspection = await inspectManagedBrowser(options, deps);
  if (hasBlockingIssues(inspection.issues)) {
    return {
      ok: false,
      summary: inspection.issues.some((issue) => issue.code === 'storage_rejected')
        ? 'Managed browser storage was rejected.'
        : 'Managed browser setup found blockers.',
      installMode: inspection.installMode,
      storageRule: inspection.storageRule,
      executablePath: inspection.executablePath,
      paths: inspection.paths,
      issues: inspection.issues,
      nextSteps: [],
    };
  }

  await deps.mkdir(inspection.paths.profileDir, { recursive: true });
  return {
    ok: true,
    summary: 'Managed browser profile is set up.',
    installMode: inspection.installMode,
    storageRule: inspection.storageRule,
    executablePath: inspection.executablePath,
    paths: inspection.paths,
    issues: inspection.issues,
    nextSteps: ['Launch headed once, log in, then close the browser.'],
  };
}

export async function doctorManagedBrowser(
  options: BrowserCliCommandOptions,
  deps: ManagedBrowserDeps = defaultDeps,
): Promise<BrowserCliReport> {
  const inspection = await inspectManagedBrowser(options, deps);
  const issues = [...inspection.issues];

  if (!hasBlockingIssues(issues)) {
    const stateRead = await readManagedBrowserState(inspection.paths.stateFile, deps);
    if (stateRead.exists && !stateRead.state) {
      issues.push({
        code: 'stale_launcher_state',
        severity: 'warn',
        message: 'Launcher state exists but is unreadable or incomplete.',
        recommendation: 'Run `discoclaw browser launch` to replace the stale launcher state.',
      });
    }

    if (stateRead.state) {
      const verified = await verifyManagedBrowserCdp(stateRead.state, deps);
      if (!verified) {
        issues.push({
          code: 'stale_launcher_state',
          severity: 'warn',
          message: 'Stored managed browser state did not verify against the current CDP endpoint.',
          recommendation: 'Close the managed browser if it is open, then rerun `discoclaw browser launch`.',
        });
      }
    }

    if (await isManagedBrowserProfileLocked(inspection.paths.profileDir, deps)) {
      issues.push({
        code: 'profile_locked',
        severity: 'warn',
        message: 'The managed browser profile currently appears to be locked.',
        recommendation: 'If this is not the verified managed browser, close it before launching again.',
      });
    }
  }

  return {
    ok: !hasBlockingIssues(issues),
    summary: hasBlockingIssues(issues)
      ? 'Managed browser doctor found blockers.'
      : 'Managed browser doctor found no blockers.',
    installMode: inspection.installMode,
    storageRule: inspection.storageRule,
    executablePath: inspection.executablePath,
    paths: inspection.paths,
    issues,
    nextSteps: !hasBlockingIssues(issues)
      ? ['Run `discoclaw browser launch` to open the managed profile for login.']
      : [],
  };
}

export async function launchManagedBrowser(
  options: BrowserCliCommandOptions,
  deps: ManagedBrowserDeps = defaultDeps,
): Promise<BrowserCliReport> {
  const inspection = await inspectManagedBrowser(options, deps);
  if (hasBlockingIssues(inspection.issues)) {
    return {
      ok: false,
      summary: inspection.issues.some((issue) => issue.code === 'storage_rejected')
        ? 'Managed browser storage was rejected.'
        : 'Managed browser launch found blockers.',
      installMode: inspection.installMode,
      storageRule: inspection.storageRule,
      executablePath: inspection.executablePath,
      paths: inspection.paths,
      issues: inspection.issues,
      nextSteps: [],
    };
  }

  await deps.mkdir(inspection.paths.profileDir, { recursive: true });

  const stateRead = await readManagedBrowserState(inspection.paths.stateFile, deps);
  let storedState = stateRead.state;
  let staleStateFound = stateRead.exists && !stateRead.state;

  if (storedState) {
    const verified = await verifyManagedBrowserCdp(storedState, deps);
    if (verified) {
      return {
        ok: true,
        summary: 'Managed browser launch verified CDP successfully.',
        installMode: inspection.installMode,
        storageRule: inspection.storageRule,
        executablePath: inspection.executablePath,
        paths: inspection.paths,
        issues: inspection.issues,
        launch: {
          reusedExisting: true,
          headless: storedState.headless,
          pid: verified.pid,
          port: verified.port,
          cdpUrl: verified.cdpUrl,
        },
        nextSteps: ['Reuse this profile later with `discoclaw browser launch --headless`.'],
      };
    }

    staleStateFound = true;
  }

  if (staleStateFound) {
    try {
      await clearManagedBrowserState(inspection.paths.stateFile, deps);
    } catch (err) {
      return {
        ok: false,
        summary: 'Managed browser launch could not clear stale launcher state.',
        installMode: inspection.installMode,
        storageRule: inspection.storageRule,
        executablePath: inspection.executablePath,
        paths: inspection.paths,
        issues: [
          ...inspection.issues,
          {
            code: 'stale_launcher_state_cleanup_failed',
            severity: 'error',
            message: 'Stored managed browser state was stale, but Discoclaw could not remove it before relaunching.',
            detail: `Failed to remove stale launcher state at ${inspection.paths.stateFile}: ${formatError(err)}`,
            recommendation: 'Delete the stale state file after confirming no managed browser is still running, then rerun `discoclaw browser launch`.',
          },
        ],
        launch: {
          reusedExisting: false,
          headless: options.headless === true,
        },
        nextSteps: [],
      };
    }
    storedState = null;
  }

  if (await isManagedBrowserProfileLocked(inspection.paths.profileDir, deps)) {
    return {
      ok: false,
      summary: 'Managed browser profile is locked by another process.',
      installMode: inspection.installMode,
      storageRule: inspection.storageRule,
      executablePath: inspection.executablePath,
      paths: inspection.paths,
      issues: [
        ...inspection.issues,
        {
          code: 'profile_locked',
          severity: 'error',
          message: 'The managed browser profile is already open, but no verified managed instance could be reused.',
          recommendation: 'Close the managed browser first, then rerun `discoclaw browser launch`.',
        },
      ],
      launch: {
        reusedExisting: false,
        headless: options.headless === true,
      },
      nextSteps: [],
    };
  }

  const shouldReuseStoredPort = Boolean(
    storedState &&
    !staleStateFound &&
    await deps.isPortAvailable(storedState.port),
  );
  const port = shouldReuseStoredPort && storedState ? storedState.port : await deps.chooseFreePort();
  const headless = options.headless === true;
  const launchArgs = buildManagedBrowserLaunchArgs({
    profileDir: inspection.paths.profileDir,
    port,
    headless,
  });
  const child = deps.spawnBrowser(inspection.executablePath!, launchArgs);

  if (!child.pid || child.pid <= 0) {
    return {
      ok: false,
      summary: 'Managed browser launch failed before a browser PID was recorded.',
      installMode: inspection.installMode,
      storageRule: inspection.storageRule,
      executablePath: inspection.executablePath,
      paths: inspection.paths,
      issues: [
        ...inspection.issues,
        {
          code: 'launch_failed',
          severity: 'error',
          message: 'Chrome/Chromium exited before Discoclaw could record its PID.',
          recommendation: 'Check the browser executable path and relaunch headed to inspect the failure.',
        },
      ],
      launch: {
        reusedExisting: false,
        headless,
        port,
      },
      nextSteps: [],
    };
  }

  const tentativeState: ManagedBrowserState = {
    pid: child.pid,
    port,
    profileDir: inspection.paths.profileDir,
    executablePath: inspection.executablePath!,
    launchedAt: deps.now().toISOString(),
    headless,
  };

  await saveManagedBrowserState(inspection.paths.stateFile, tentativeState, deps);

  const verified = await waitForManagedBrowserVerification(
    { pid: child.pid, port },
    deps,
  );

  if (!verified) {
    const exitConfirmed = await waitForManagedBrowserExit(child.pid, deps);

    if (!exitConfirmed) {
      return {
        ok: false,
        summary: 'Managed browser launch failed after CDP verification could not be confirmed.',
        installMode: inspection.installMode,
        storageRule: inspection.storageRule,
        executablePath: inspection.executablePath,
        paths: inspection.paths,
        issues: [
          ...inspection.issues,
          {
            code: 'verification_termination_unconfirmed',
            severity: 'error',
            message: 'CDP verification failed, and Discoclaw could not confirm that the newly launched browser exited after requesting termination.',
            detail: `Tentative launcher state was left at ${inspection.paths.stateFile} because browser exit could not be verified.`,
            recommendation: 'Close the browser manually if it is still open, then delete the tentative state file before retrying.',
          },
        ],
        launch: {
          reusedExisting: false,
          headless,
          pid: child.pid,
          port,
        },
        nextSteps: [],
      };
    }

    try {
      await clearManagedBrowserState(inspection.paths.stateFile, deps);
      return {
        ok: false,
        summary: 'Managed browser launch failed after CDP verification could not be confirmed.',
        installMode: inspection.installMode,
        storageRule: inspection.storageRule,
        executablePath: inspection.executablePath,
        paths: inspection.paths,
        issues: [
          ...inspection.issues,
          {
            code: 'verification_failed',
            severity: 'error',
            message: 'Discoclaw confirmed the newly launched browser is no longer running after CDP verification failed and removed the tentative launcher state.',
            recommendation: 'Relaunch headed, confirm the browser stays open, then retry after manual login if needed.',
          },
        ],
        launch: {
          reusedExisting: false,
          headless,
          pid: child.pid,
          port,
        },
        nextSteps: [],
      };
    } catch (err) {
      return {
        ok: false,
        summary: 'Managed browser launch failed after CDP verification could not be confirmed.',
        installMode: inspection.installMode,
        storageRule: inspection.storageRule,
        executablePath: inspection.executablePath,
        paths: inspection.paths,
        issues: [
          ...inspection.issues,
          {
            code: 'verification_cleanup_failed',
            severity: 'error',
            message: 'Discoclaw confirmed the newly launched browser is no longer running, but launcher-state cleanup still failed.',
            detail: `Failed to remove stale launcher state at ${inspection.paths.stateFile}: ${formatError(err)}`,
            recommendation: 'Delete the stale state file after confirming no managed browser is still running.',
          },
        ],
        launch: {
          reusedExisting: false,
          headless,
          pid: child.pid,
          port,
        },
        nextSteps: [],
      };
    }
  }

  await saveManagedBrowserState(inspection.paths.stateFile, {
    ...tentativeState,
    cdpUrl: verified.cdpUrl,
  }, deps);

  return {
    ok: true,
    summary: 'Managed browser launch verified CDP successfully.',
    installMode: inspection.installMode,
    storageRule: inspection.storageRule,
    executablePath: inspection.executablePath,
    paths: inspection.paths,
    issues: inspection.issues,
    launch: {
      reusedExisting: false,
      headless,
      pid: verified.pid,
      port: verified.port,
      cdpUrl: verified.cdpUrl,
    },
    nextSteps: headless
      ? ['Reuse this profile later with `discoclaw browser launch --headless`.']
      : ['Log in if needed, then close the browser so later launches can reuse the same profile.'],
  };
}

export const runBrowserSetup = setupManagedBrowser;
export const browserSetup = setupManagedBrowser;
export const runBrowserDoctor = doctorManagedBrowser;
export const browserDoctor = doctorManagedBrowser;
export const runBrowserLaunch = launchManagedBrowser;
export const browserLaunch = launchManagedBrowser;

async function inspectManagedBrowser(
  options: BrowserCliCommandOptions,
  deps: ManagedBrowserDeps,
): Promise<ManagedBrowserInspection> {
  const storage = enforceManagedBrowserStorageRule({
    cwd: options.cwd,
    dataDir: options.env.DISCOCLAW_DATA_DIR,
    deps,
  });
  const issues = storage.ok ? [] : [storage.issue];
  const executable = storage.ok
    ? await discoverManagedBrowserExecutable(options.env, options.cwd, deps)
    : { executablePath: null, issues: [] as BrowserCliIssue[] };

  return {
    installMode: storage.installMode,
    storageRule: storage.storageRule,
    paths: storage.paths,
    defaultPaths: resolveManagedBrowserPaths(undefined, options.cwd),
    executablePath: executable.executablePath,
    issues: [...issues, ...executable.issues],
  };
}

async function waitForManagedBrowserVerification(
  state: Pick<ManagedBrowserState, 'pid' | 'port'>,
  deps: Pick<ManagedBrowserDeps, 'sleep' | 'now'> & Pick<ManagedBrowserDeps, 'isPidAlive' | 'httpGetJson' | 'websocketProbe'>,
): Promise<ManagedBrowserVerification | null> {
  const deadline = deps.now().getTime() + POST_SPAWN_VERIFY_TIMEOUT_MS;
  do {
    const verified = await verifyManagedBrowserCdp(state, deps);
    if (verified) return verified;
    if (!deps.isPidAlive(state.pid)) return null;
    await deps.sleep(POST_SPAWN_VERIFY_POLL_MS);
  } while (deps.now().getTime() < deadline);

  return null;
}

async function waitForManagedBrowserExit(
  pid: number,
  deps: Pick<ManagedBrowserDeps, 'killPid' | 'isPidAlive' | 'sleep' | 'now'>,
): Promise<boolean> {
  if (!deps.isPidAlive(pid)) return true;

  deps.killPid(pid);

  const deadline = deps.now().getTime() + POST_TERMINATION_VERIFY_TIMEOUT_MS;
  do {
    if (!deps.isPidAlive(pid)) return true;
    await deps.sleep(POST_TERMINATION_VERIFY_POLL_MS);
  } while (deps.now().getTime() < deadline);

  return !deps.isPidAlive(pid);
}

async function readManagedBrowserState(
  filePath: string,
  deps: Pick<ManagedBrowserDeps, 'readFile'> = defaultDeps,
): Promise<ManagedBrowserReadStateResult> {
  let raw: string;
  try {
    raw = await deps.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, state: null };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, state: null };
  }

  return {
    exists: true,
    state: parseManagedBrowserState(parsed),
  };
}

function parseManagedBrowserState(value: unknown): ManagedBrowserState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate['pid'] !== 'number' ||
    typeof candidate['port'] !== 'number' ||
    typeof candidate['profileDir'] !== 'string' ||
    typeof candidate['executablePath'] !== 'string' ||
    typeof candidate['launchedAt'] !== 'string' ||
    typeof candidate['headless'] !== 'boolean'
  ) {
    return null;
  }

  if (candidate['cdpUrl'] !== undefined && typeof candidate['cdpUrl'] !== 'string') {
    return null;
  }

  return {
    pid: candidate['pid'],
    port: candidate['port'],
    profileDir: candidate['profileDir'],
    executablePath: candidate['executablePath'],
    launchedAt: candidate['launchedAt'],
    headless: candidate['headless'],
    ...(typeof candidate['cdpUrl'] === 'string' && candidate['cdpUrl'].length > 0
      ? { cdpUrl: candidate['cdpUrl'] }
      : {}),
  };
}

async function isManagedBrowserProfileLocked(
  profileDir: string,
  deps: Pick<ManagedBrowserDeps, 'access'> = defaultDeps,
): Promise<boolean> {
  for (const filename of PROFILE_LOCK_FILES) {
    if (await pathExists(path.join(profileDir, filename), deps.access)) {
      return true;
    }
  }
  return false;
}

function parseJsonVersionPayload(
  value: unknown,
  expectedPort: number,
): {
  browser?: string;
  protocolVersion?: string;
  cdpUrl: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['webSocketDebuggerUrl'] !== 'string' || candidate['webSocketDebuggerUrl'].length === 0) {
    return null;
  }

  const cdpUrl = parseBrowserDebuggerUrl(candidate['webSocketDebuggerUrl']);
  if (!cdpUrl) return null;
  if (Number(cdpUrl.port) !== expectedPort) return null;

  return {
    cdpUrl: cdpUrl.href,
    ...(typeof candidate['Browser'] === 'string' ? { browser: candidate['Browser'] } : {}),
    ...(typeof candidate['Protocol-Version'] === 'string'
      ? { protocolVersion: candidate['Protocol-Version'] }
      : {}),
  };
}

function parseBrowserDebuggerUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'ws:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname !== CDP_HOST) return null;
  if (!parsed.port) return null;
  if (!parsed.pathname.startsWith('/devtools/browser/')) return null;
  if (parsed.pathname.length <= '/devtools/browser/'.length) return null;
  if (parsed.search || parsed.hash) return null;
  return parsed;
}

function hasBlockingIssues(issues: BrowserCliIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = (value ?? '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function isPathWithin(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(normalizePath(parentPath), normalizePath(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(
  targetPath: string,
  accessFn: Pick<ManagedBrowserDeps, 'access'>['access'],
): Promise<boolean> {
  try {
    await accessFn(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  try {
    const result = await execa(process.platform === 'win32' ? 'where' : 'which', [command], {
      timeout: 2_000,
    });
    const candidate = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
    return candidate || null;
  } catch {
    return null;
  }
}

function spawnManagedBrowserProcess(executablePath: string, args: string[]): ChildProcess {
  const child = spawn(executablePath, args, {
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, CDP_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function chooseFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, CDP_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to determine a free local CDP port.')));
        return;
      }

      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      if ((response.statusCode ?? 0) >= 400) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? 0}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (err) {
          reject(err);
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.once('error', reject);
  });
}

async function websocketBrowserGetVersion(
  cdpUrl: string,
  timeoutMs: number,
): Promise<{ browser?: string; protocolVersion?: string }> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(cdpUrl);
    let settled = false;
    const finish = (err?: unknown, value?: { browser?: string; protocolVersion?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        // Ignore close failures on teardown.
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(value ?? {});
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.once('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Browser.getVersion',
      }));
    });

    ws.on('message', (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch (err) {
        finish(err);
        return;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const payload = parsed as Record<string, unknown>;
      if (payload['id'] !== 1) return;
      if (payload['error']) {
        finish(new Error('Browser.getVersion returned an error response.'));
        return;
      }

      const result = payload['result'];
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        finish(new Error('Browser.getVersion returned an invalid payload.'));
        return;
      }

      const resultObject = result as Record<string, unknown>;
      finish(undefined, {
        ...(typeof resultObject['product'] === 'string' ? { browser: resultObject['product'] } : {}),
        ...(typeof resultObject['protocolVersion'] === 'string'
          ? { protocolVersion: resultObject['protocolVersion'] }
          : {}),
      });
    });

    ws.once('error', (err) => finish(err));
    ws.once('close', () => finish(new Error('WebSocket closed before Browser.getVersion completed.')));
  });
}

function formatError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
