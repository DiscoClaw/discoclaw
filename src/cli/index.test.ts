import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

afterEach(async () => {
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
