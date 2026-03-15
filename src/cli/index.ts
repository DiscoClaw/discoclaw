#!/usr/bin/env node
/**
 * discoclaw CLI entrypoint.
 * Usage: discoclaw <command> [options]
 */

import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunDashboardOptions } from './dashboard.js';
import type { DashboardServer, DashboardServerOptions } from '../dashboard/server.js';
import { runInitWizard } from './init-wizard.js';
import { runDaemonInstaller } from './daemon-installer.js';
import type { DoctorFinding, DoctorReport, FixResult } from '../health/config-doctor.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const DASHBOARD_PORT_PROBE_TIMEOUT_MS = 250;

export type DashboardCliDeps = {
  runDashboard: (options?: RunDashboardOptions) => Promise<void>;
  startDashboardServer: (options?: DashboardServerOptions) => Promise<DashboardServer>;
  formatDashboardListenUrl: (
    address: { address?: string; port?: number } | null | undefined,
    fallbackHost: string,
    fallbackPort: number,
  ) => string;
  formatDashboardUrl: (host: string, port: number) => string;
  parseDashboardPort: (env: NodeJS.ProcessEnv) => number;
  parseDashboardTrustedHosts: (env: NodeJS.ProcessEnv) => Set<string>;
  resolveDashboardBindHost: (trustedHosts: Set<string>) => string;
  loadDotenv: (options: { path: string }) => void;
  waitForSignal: () => Promise<NodeJS.Signals>;
  probePort: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  log: Pick<typeof console, 'log' | 'error'>;
};

export async function probeTcpPortOccupancy(
  host: string,
  port: number,
  timeoutMs = DASHBOARD_PORT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export function formatDashboardPortConflictMessage(host: string, port: number): string {
  return (
    `Dashboard port ${port} on ${host} is already accepting TCP connections. ` +
    'Set DISCOCLAW_DASHBOARD_PORT to a different port in .env before running `discoclaw dashboard`. ' +
    'The discoclaw service dashboard may already own this port.'
  );
}

async function loadDashboardCliDeps(): Promise<DashboardCliDeps> {
  const { runDashboard, startDashboardServer } = await import('./dashboard.js');
  const {
    formatDashboardListenUrl,
    formatDashboardUrl,
    parseDashboardPort,
    parseDashboardTrustedHosts,
    resolveDashboardBindHost,
  } = await import('../dashboard/options.js');
  const { config } = await import('dotenv');

  return {
    runDashboard,
    startDashboardServer,
    formatDashboardListenUrl,
    formatDashboardUrl,
    parseDashboardPort,
    parseDashboardTrustedHosts,
    resolveDashboardBindHost,
    loadDotenv: config,
    waitForSignal: waitForDashboardSignal,
    probePort: probeTcpPortOccupancy,
    log: console,
  };
}

export async function runDashboardCliCommand(options: {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deps?: DashboardCliDeps;
} = {}): Promise<number> {
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const deps = options.deps ?? await loadDashboardCliDeps();
  const useLegacyDashboard = argv.includes('--legacy');

  if (useLegacyDashboard) {
    await deps.runDashboard({ cwd, env });
    return 0;
  }

  deps.loadDotenv({ path: path.join(cwd, '.env') });

  try {
    const port = deps.parseDashboardPort(env);
    const trustedHosts = deps.parseDashboardTrustedHosts(env);
    const host = deps.resolveDashboardBindHost(trustedHosts);

    if (await deps.probePort(host, port)) {
      deps.log.error(formatDashboardPortConflictMessage(host, port));
      return 1;
    }

    const handle = await deps.startDashboardServer({
      cwd,
      env,
      host,
      port,
      trustedHosts,
    });
    const address = handle.server.address() as { address: string; port: number } | null;
    const boundPort = address?.port ?? port;
    deps.log.log(`Discoclaw dashboard listening at ${deps.formatDashboardListenUrl(address, host, port)}`);
    if (trustedHosts.size > 0) {
      const [firstTrustedHost] = trustedHosts;
      deps.log.log(`Trusted host URL: ${deps.formatDashboardUrl(firstTrustedHost, boundPort)}`);
    }
    deps.log.log('Press Ctrl+C to stop.');
    await deps.waitForSignal();
    await handle.close();
    return 0;
  } catch (err) {
    deps.log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runCli(argv = process.argv): Promise<number> {
  const [, , command] = argv;

  switch (command) {
    case 'init':
      await runInitWizard();
      return 0;
    case 'install-daemon':
      await runDaemonInstaller();
      return 0;
    case 'dashboard':
      return await runDashboardCliCommand({ argv, cwd: process.cwd(), env: process.env });
    case 'doctor': {
      const cwd = process.cwd();
      const shouldFix = argv.includes('--fix');
      const { config } = await import('dotenv');
      const { inspect, applyFixes } = await import('../health/config-doctor.js');

      config({ path: path.join(cwd, '.env') });

      const report = await inspect({ cwd, env: process.env });
      printDoctorReport(report);

      if (shouldFix) {
        const result = await applyFixes(report, { cwd, env: process.env });
        printDoctorFixResult(result);
      }
      return 0;
    }
    case 'update': {
      const subcommand = argv[3];
      const { isNpmManaged, getLocalVersion, getLatestNpmVersion, npmGlobalUpgrade } =
        await import('../npm-managed.js');
      const npmMode = await isNpmManaged();

      if (subcommand === 'apply') {
        if (!npmMode) {
          console.error('This instance is not npm-managed. Use the git-based workflow to update.');
          return 1;
        }
        console.log('Installing latest version from npm...');
        const result = await npmGlobalUpgrade();
        if (result.exitCode !== 0) {
          const detail = (result.stderr || result.stdout).trim().slice(0, 500);
          console.error(`npm install -g discoclaw failed:\n${detail}`);
          return 1;
        }
        console.log('Update complete. Restart discoclaw to run the new version.');
        return 0;
      }

      if (subcommand === undefined) {
        if (!npmMode) {
          console.log('This instance is not npm-managed; update checking is not supported in this mode.');
          return 0;
        }
        const installed = getLocalVersion();
        const latest = await getLatestNpmVersion();
        if (latest === null) {
          console.error('Failed to fetch latest version from npm registry.');
          return 1;
        }
        if (installed === latest) {
          console.log(`Already on latest version (${installed}).`);
        } else {
          console.log(`Update available: ${installed} → ${latest}. Run \`discoclaw update apply\` to upgrade.`);
        }
        return 0;
      }

      console.error(`Unknown update subcommand: ${subcommand}\n`);
      printHelp(version);
      return 1;
    }
    case '--version':
    case '-v':
      console.log(version);
      return 0;
    case '--help':
    case '-h':
    case undefined:
      printHelp(version);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp(version);
      return 1;
  }
}

function printHelp(ver: string): void {
  console.log(
    `discoclaw v${ver} — Personal AI orchestrator\n` +
      `\nUsage: discoclaw <command>\n` +
      `\nCommands:\n` +
      `  init                                  Interactive setup wizard — creates .env and workspace/\n` +
      `  dashboard                             Local web dashboard for common admin tasks (HTTP on 127.0.0.1 by default)\n` +
      `  doctor [--fix]                        Inspect config drift, deprecated env vars, conflicting/stale overrides, and missing secrets; use --fix for auto-fixes\n` +
      `  install-daemon [--service-name <name>]  Register discoclaw as a persistent background service\n` +
      `                                          Use --service-name to run multiple instances side-by-side.\n` +
      `                                          Defaults to "discoclaw".\n` +
      `  update                                Check for available updates (npm-managed installs only)\n` +
      `  update apply                          Install the latest version from npm and print restart reminder\n` +
      `\nOptions:\n` +
      `  -v, --version   Print version\n` +
      `  -h, --help      Print this help\n`,
  );
}

function printDoctorReport(report: DoctorReport): void {
  const severityCounts = countDoctorSeverities(report.findings);

  console.log(`Doctor report for ${report.configPaths.cwd}`);
  console.log(`  Install mode: ${report.installMode}`);
  console.log(`  .env: ${report.configPaths.env}`);
  console.log(`  data dir: ${report.configPaths.dataDir}`);
  console.log(`  models: ${report.configPaths.models}`);
  console.log(`  runtime overrides: ${report.configPaths.runtimeOverrides}`);
  console.log(
    `  Findings: ${report.findings.length} (errors=${severityCounts.error}, warnings=${severityCounts.warn}, info=${severityCounts.info})`,
  );

  if (report.findings.length === 0) {
    console.log('\nNo config doctor findings.');
    return;
  }

  console.log('');
  for (const finding of report.findings) {
    printDoctorFinding(finding);
  }
}

function printDoctorFinding(finding: DoctorFinding): void {
  const autoFixLabel = finding.autoFixable ? 'auto-fixable' : 'manual-fix';
  console.log(`[${finding.severity.toUpperCase()}] ${finding.id} (${autoFixLabel})`);
  console.log(`  ${finding.message}`);
  console.log(`  Recommended fix: ${finding.recommendation}`);
}

function printDoctorFixResult(result: FixResult): void {
  console.log('\nFix results:');
  console.log(`  Applied: ${result.applied.length}`);
  console.log(`  Skipped: ${result.skipped.length}`);
  console.log(`  Errors: ${result.errors.length}`);
  console.log('  Restart required: restart discoclaw for fixed config to take effect.');

  if (result.applied.length > 0) {
    console.log('\nApplied fixes:');
    for (const id of result.applied) {
      console.log(`  - ${id}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('\nSkipped fixes:');
    for (const entry of result.skipped) {
      console.log(`  - ${entry.id}: ${entry.reason}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('\nFix errors:');
    for (const entry of result.errors) {
      console.log(`  - ${entry.id}: ${entry.message}`);
    }
  }
}

function countDoctorSeverities(findings: DoctorFinding[]): Record<'error' | 'warn' | 'info', number> {
  return findings.reduce<Record<'error' | 'warn' | 'info', number>>(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { error: 0, warn: 0, info: 0 },
  );
}

function waitForDashboardSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const cleanup = () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    const onSigint = () => {
      cleanup();
      resolve('SIGINT');
    };
    const onSigterm = () => {
      cleanup();
      resolve('SIGTERM');
    };

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const exitCode = await runCli(process.argv);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
