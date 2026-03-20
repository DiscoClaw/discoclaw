import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runBrowserCliCommand,
  runCli,
  type BrowserCliDeps,
  type BrowserCliReport,
  formatDashboardPortConflictMessage,
  probeTcpPortOccupancy,
  runDashboardCliCommand,
  type DashboardCliDeps,
} from './index.js';
import type { DashboardServer } from '../dashboard/server.js';

const servers: net.Server[] = [];

async function listenTcpServer(): Promise<{ server: net.Server; host: string; port: number }> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return { server, host: '127.0.0.1', port: address.port };
}

function makeDashboardDeps(overrides: Partial<DashboardCliDeps> = {}): DashboardCliDeps {
  const makeServer = (close = vi.fn(async () => undefined)): DashboardServer => ({
    server: {
      address: () => ({ address: '127.0.0.1', port: 9401 }),
    } as unknown as DashboardServer['server'],
    close,
  });

  return {
    runDashboard: vi.fn(async () => undefined),
    startDashboardServer: vi.fn(async () => makeServer()) as unknown as DashboardCliDeps['startDashboardServer'],
    formatDashboardListenUrl: vi.fn(() => 'http://127.0.0.1:9401/'),
    formatDashboardUrl: vi.fn((host: string, port: number) => `http://${host}:${port}/`),
    parseDashboardPort: vi.fn(() => 9401),
    parseDashboardTrustedHosts: vi.fn(() => new Set<string>()),
    resolveDashboardBindHost: vi.fn(() => '127.0.0.1'),
    loadDotenv: vi.fn(),
    waitForSignal: vi.fn(async () => 'SIGTERM' as NodeJS.Signals),
    probePort: vi.fn(async () => false),
    log: {
      log: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

function makeBrowserReport(overrides: Partial<BrowserCliReport> = {}): BrowserCliReport {
  return {
    ok: true,
    summary: 'Managed browser profile is ready for use.',
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

function makeBrowserDeps(overrides: Partial<BrowserCliDeps> = {}): BrowserCliDeps {
  return {
    setup: vi.fn(async () => makeBrowserReport({
      summary: 'Managed browser profile is set up.',
      nextSteps: ['Launch headed once, log in, then close the browser.'],
    })),
    doctor: vi.fn(async () => makeBrowserReport({
      summary: 'Managed browser doctor found no blockers.',
    })),
    launch: vi.fn(async () => makeBrowserReport({
      summary: 'Managed browser launch verified CDP successfully.',
      launch: {
        reusedExisting: false,
        headless: false,
        pid: 4242,
        port: 9222,
        cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      },
      nextSteps: ['Reuse this profile later with `discoclaw browser launch --headless`.'],
    })),
    loadDotenv: vi.fn(),
    log: {
      log: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

function loggedText(fn: { mock: { calls: unknown[][] } }): string {
  return fn.mock.calls.flatMap((call) => call.map((entry) => String(entry))).join('\n');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }),
  );
});

describe('probeTcpPortOccupancy', () => {
  it('returns true when a listener is already bound', async () => {
    const { host, port } = await listenTcpServer();
    await expect(probeTcpPortOccupancy(host, port)).resolves.toBe(true);
  });

  it('returns false when no listener is bound', async () => {
    const { host, port, server } = await listenTcpServer();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    servers.splice(servers.indexOf(server), 1);

    await expect(probeTcpPortOccupancy(host, port, 100)).resolves.toBe(false);
  });
});

describe('runDashboardCliCommand', () => {
  it('returns a non-zero exit code with a clear diagnostic when the port is occupied', async () => {
    const deps = makeDashboardDeps({
      probePort: vi.fn(async () => true),
    });

    const exitCode = await runDashboardCliCommand({
      argv: ['node', 'discoclaw', 'dashboard'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(1);
    expect(deps.probePort).toHaveBeenCalledWith('127.0.0.1', 9401);
    expect(deps.startDashboardServer).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(formatDashboardPortConflictMessage('127.0.0.1', 9401));
    expect(deps.log.error).toHaveBeenCalledWith(
      expect.stringContaining('DISCOCLAW_DASHBOARD_PORT'),
    );
    expect(deps.log.error).toHaveBeenCalledWith(
      expect.stringContaining('service dashboard may already own this port'),
    );
  });

  it('checks the target port before boot and aborts when another TCP listener owns it', async () => {
    const { port } = await listenTcpServer();
    const deps = makeDashboardDeps({
      parseDashboardPort: vi.fn(() => port),
      probePort: probeTcpPortOccupancy,
    });

    const exitCode = await runDashboardCliCommand({
      argv: ['node', 'discoclaw', 'dashboard'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(1);
    expect(deps.startDashboardServer).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      formatDashboardPortConflictMessage('127.0.0.1', port),
    );
  });

  it('starts the dashboard server when the port probe fails to connect', async () => {
    const close = vi.fn(async () => undefined);
    const deps = makeDashboardDeps({
      startDashboardServer: vi.fn(async () => ({
        server: {
          address: () => ({ address: '127.0.0.1', port: 9401 }),
        } as unknown as DashboardServer['server'],
        close,
      })) as unknown as DashboardCliDeps['startDashboardServer'],
    });

    const exitCode = await runDashboardCliCommand({
      argv: ['node', 'discoclaw', 'dashboard'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(0);
    expect(deps.startDashboardServer).toHaveBeenCalledWith({
      cwd: '/repo',
      env: {},
      host: '127.0.0.1',
      port: 9401,
      trustedHosts: new Set(),
    });
    expect(deps.log.log).toHaveBeenCalledWith(
      'Discoclaw dashboard listening at http://127.0.0.1:9401/',
    );
    expect(deps.log.log).toHaveBeenCalledWith('Press Ctrl+C to stop.');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('runCli browser commands', () => {
  it('dispatches browser setup through the shared browser deps', async () => {
    const deps = makeBrowserDeps();

    const exitCode = await runCli(['node', 'discoclaw', 'browser', 'setup'], {
      browser: deps,
    });

    expect(exitCode).toBe(0);
    expect(deps.setup).toHaveBeenCalledWith({
      cwd: process.cwd(),
      env: process.env,
    });
    expect(deps.doctor).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('dispatches browser doctor through the shared browser deps', async () => {
    const deps = makeBrowserDeps();

    const exitCode = await runCli(['node', 'discoclaw', 'browser', 'doctor'], {
      browser: deps,
    });

    expect(exitCode).toBe(0);
    expect(deps.doctor).toHaveBeenCalledWith({
      cwd: process.cwd(),
      env: process.env,
    });
  });

  it('passes the headless flag to browser launch', async () => {
    const deps = makeBrowserDeps();

    const exitCode = await runCli(['node', 'discoclaw', 'browser', 'launch', '--headless'], {
      browser: deps,
    });

    expect(exitCode).toBe(0);
    expect(deps.launch).toHaveBeenCalledWith({
      cwd: process.cwd(),
      env: process.env,
      headless: true,
    });
  });

  it('prints the browser commands in top-level help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const exitCode = await runCli(['node', 'discoclaw', '--help']);

    expect(exitCode).toBe(0);
    const output = loggedText(log);
    expect(output).toContain('browser setup');
    expect(output).toContain('browser doctor');
    expect(output).toContain('browser launch [--headless]');
  });

  it('returns non-zero and prints browser help for unknown browser subcommands', async () => {
    const deps = makeBrowserDeps();

    const exitCode = await runCli(['node', 'discoclaw', 'browser', 'unknown'], {
      browser: deps,
    });

    expect(exitCode).toBe(1);
    const output = loggedText(deps.log.error as ReturnType<typeof vi.fn>);
    expect(output).toContain('Unknown browser subcommand: unknown');
    expect(output).toContain('Usage: discoclaw browser <subcommand>');
  });
});

describe('runBrowserCliCommand', () => {
  it('returns a non-zero exit code for rejected in-repo custom data dirs', async () => {
    const deps = makeBrowserDeps({
      setup: vi.fn(async () => makeBrowserReport({
        ok: false,
        summary: 'Managed browser storage was rejected.',
        paths: {
          dataDir: '/repo/custom-data/browser',
          profileDir: '/repo/custom-data/browser/profile',
          stateFile: '/repo/custom-data/browser/state.json',
        },
        issues: [
          {
            code: 'storage_rejected',
            severity: 'error',
            message: 'Custom in-repo DISCOCLAW_DATA_DIR values are rejected for managed browser storage.',
            recommendation: 'Move DISCOCLAW_DATA_DIR outside the repo or use the default data/browser path.',
          },
        ],
      })),
    });

    const exitCode = await runBrowserCliCommand({
      argv: ['node', 'discoclaw', 'browser', 'setup'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(1);
    const output = loggedText(deps.log.error as ReturnType<typeof vi.fn>);
    expect(output).toContain('Managed browser storage was rejected.');
    expect(output).toContain('[ERROR] storage_rejected');
    expect(output).toContain('Move DISCOCLAW_DATA_DIR outside the repo');
    expect(output).toContain('/repo/custom-data/browser');
  });

  it('loads .env before dispatching browser subcommands', async () => {
    const deps = makeBrowserDeps();

    const exitCode = await runBrowserCliCommand({
      argv: ['node', 'discoclaw', 'browser', 'doctor'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(0);
    expect(deps.loadDotenv).toHaveBeenCalledWith({ path: '/repo/.env' });
    expect(deps.doctor).toHaveBeenCalledWith({
      cwd: '/repo',
      env: {},
    });
  });

  it('returns a non-zero exit code when the managed profile is locked and cannot be reused', async () => {
    const deps = makeBrowserDeps({
      launch: vi.fn(async () => makeBrowserReport({
        ok: false,
        summary: 'Managed browser profile is locked by another process.',
        launch: {
          reusedExisting: false,
          headless: false,
        },
        issues: [
          {
            code: 'profile_locked',
            severity: 'error',
            message: 'The managed browser profile is already open, but no verified managed instance could be reused.',
            recommendation: 'Close the managed browser first, then rerun `discoclaw browser launch`.',
          },
        ],
      })),
    });

    const exitCode = await runBrowserCliCommand({
      argv: ['node', 'discoclaw', 'browser', 'launch'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(1);
    const output = loggedText(deps.log.error as ReturnType<typeof vi.fn>);
    expect(output).toContain('Managed browser profile is locked by another process.');
    expect(output).toContain('[ERROR] profile_locked');
    expect(output).toContain('Close the managed browser first');
  });

  it('returns a non-zero exit code when verification fails and cleanup also fails', async () => {
    const deps = makeBrowserDeps({
      launch: vi.fn(async () => makeBrowserReport({
        ok: false,
        summary: 'Managed browser launch failed after CDP verification could not be confirmed.',
        launch: {
          reusedExisting: false,
          headless: true,
          pid: 5512,
          port: 9333,
        },
        issues: [
          {
            code: 'verification_cleanup_failed',
            severity: 'error',
            message: 'Discoclaw confirmed the newly launched browser is no longer running, but launcher-state cleanup still failed.',
            detail: 'Failed to remove stale launcher state at /repo/data/browser/state.json: EBUSY',
            recommendation: 'Delete the stale state file after confirming no managed browser is still running.',
          },
        ],
      })),
    });

    const exitCode = await runBrowserCliCommand({
      argv: ['node', 'discoclaw', 'browser', 'launch', '--headless'],
      cwd: '/repo',
      env: {},
      deps,
    });

    expect(exitCode).toBe(1);
    const output = loggedText(deps.log.error as ReturnType<typeof vi.fn>);
    expect(output).toContain('Managed browser launch failed after CDP verification could not be confirmed.');
    expect(output).toContain('[ERROR] verification_cleanup_failed');
    expect(output).toContain('Failed to remove stale launcher state');
    expect(output).toContain('Delete the stale state file');
  });
});
