#!/usr/bin/env node
/**
 * discoclaw CLI entrypoint.
 * Usage: discoclaw <command> [options]
 */

import { execa } from 'execa';
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

export type BrowserCliIssue = {
  code: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  detail?: string;
  recommendation?: string;
};

export type BrowserCliReport = {
  ok: boolean;
  summary: string;
  installMode?: string;
  storageRule?: string;
  executablePath?: string | null;
  paths?: Partial<{
    dataDir: string;
    profileDir: string;
    stateFile: string;
  }>;
  launch?: Partial<{
    reusedExisting: boolean;
    headless: boolean;
    pid: number;
    port: number;
    cdpUrl: string;
  }>;
  issues?: BrowserCliIssue[];
  nextSteps?: string[];
};

export type BrowserCliCommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  headless?: boolean;
};

export type BrowserCliDeps = {
  setup: (options: BrowserCliCommandOptions) => Promise<BrowserCliReport>;
  doctor: (options: BrowserCliCommandOptions) => Promise<BrowserCliReport>;
  launch: (options: BrowserCliCommandOptions) => Promise<BrowserCliReport>;
  loadDotenv: (options: { path: string }) => void;
  log: Pick<typeof console, 'log' | 'error'>;
};

export type CliDeps = {
  dashboard?: DashboardCliDeps;
  browser?: BrowserCliDeps;
  claude?: ClaudeCliDeps;
};

export type ClaudeAuthSmokeStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'missing-cli'
  | 'failed';

export type ClaudeAuthSmokeCommandResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  errorCode?: string;
  shortMessage?: string;
};

export type ClaudeCliDeps = {
  loadDotenv: (options: { path: string }) => { parsed?: Record<string, string> } | undefined;
  runClaudeFn: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<ClaudeAuthSmokeCommandResult>;
  log: Pick<typeof console, 'log' | 'error'>;
};

const CLAUDE_AUTH_SMOKE_PROMPT = 'Reply with OK';
const CLAUDE_AUTH_SMOKE_TIMEOUT_MS = 60_000;

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

async function loadBrowserCliDeps(): Promise<BrowserCliDeps> {
  const module = await importBrowserCliModule('../browser/managed-browser.js');
  const { config } = await import('dotenv');

  return {
    setup: selectBrowserCliHandler(module, ['setupManagedBrowser', 'runBrowserSetup', 'browserSetup']),
    doctor: selectBrowserCliHandler(module, ['doctorManagedBrowser', 'runBrowserDoctor', 'browserDoctor']),
    launch: selectBrowserCliHandler(module, ['launchManagedBrowser', 'runBrowserLaunch', 'browserLaunch']),
    loadDotenv: config,
    log: console,
  };
}

async function loadClaudeCliDeps(): Promise<ClaudeCliDeps> {
  const { config } = await import('dotenv');

  return {
    loadDotenv: config,
    runClaudeFn: runClaudeAuthSmokeCommand,
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

export async function runBrowserCliCommand(options: {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deps?: BrowserCliDeps;
} = {}): Promise<number> {
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const deps = options.deps ?? await loadBrowserCliDeps();
  const subcommand = argv[3];

  deps.loadDotenv({ path: path.join(cwd, '.env') });

  try {
    switch (subcommand) {
      case 'setup': {
        const report = await deps.setup({ cwd, env });
        printBrowserReport(report, report.ok ? deps.log.log : deps.log.error);
        return report.ok ? 0 : 1;
      }
      case 'doctor': {
        const report = await deps.doctor({ cwd, env });
        printBrowserReport(report, report.ok ? deps.log.log : deps.log.error);
        return report.ok ? 0 : 1;
      }
      case 'launch': {
        const report = await deps.launch({ cwd, env, headless: argv.includes('--headless') });
        printBrowserReport(report, report.ok ? deps.log.log : deps.log.error);
        return report.ok ? 0 : 1;
      }
      case undefined:
      case '--help':
      case '-h':
        printBrowserHelp(deps.log.log);
        return 0;
      default:
        deps.log.error(`Unknown browser subcommand: ${subcommand}\n`);
        printBrowserHelp(deps.log.error);
        return 1;
    }
  } catch (err) {
    printBrowserCommandError(err, deps.log.error);
    return 1;
  }
}

export async function runClaudeCliCommand(options: {
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  deps?: ClaudeCliDeps;
} = {}): Promise<number> {
  const argv = options.argv ?? process.argv;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const deps = options.deps ?? await loadClaudeCliDeps();
  const subcommand = argv[3];

  const dotenvResult = deps.loadDotenv({ path: path.join(cwd, '.env') });
  const runtimeEnv = {
    ...env,
    ...(dotenvResult?.parsed ?? {}),
  };

  switch (subcommand) {
    case 'auth-smoke':
      return await runClaudeAuthSmoke({
        argv,
        cwd,
        env: runtimeEnv,
        deps,
      });
    case undefined:
    case '--help':
    case '-h':
      printClaudeHelp(deps.log.log);
      return 0;
    default:
      deps.log.error(`Unknown claude subcommand: ${subcommand}\n`);
      printClaudeHelp(deps.log.error);
      return 1;
  }
}

export async function runCli(argv = process.argv, deps: CliDeps = {}): Promise<number> {
  const [, , command] = argv;

  switch (command) {
    case 'init':
      await runInitWizard();
      return 0;
    case 'install-daemon':
      await runDaemonInstaller();
      return 0;
    case 'dashboard':
      return await runDashboardCliCommand({ argv, cwd: process.cwd(), env: process.env, deps: deps.dashboard });
    case 'browser':
      return await runBrowserCliCommand({ argv, cwd: process.cwd(), env: process.env, deps: deps.browser });
    case 'claude':
      return await runClaudeCliCommand({ argv, cwd: process.cwd(), env: process.env, deps: deps.claude });
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
      `  browser setup                         Create the managed browser profile and print one-time login guidance\n` +
      `  browser doctor                        Inspect browser readiness, storage enforcement, and managed-instance status\n` +
      `  browser launch [--headless]           Launch or reuse the managed browser profile after verified CDP handoff\n` +
      `  claude auth-smoke                     Run one minimal Claude CLI prompt to verify the npm-managed shell can reach an authenticated Claude session\n` +
      `  init                                  Interactive setup wizard — creates .env and workspace/\n` +
      `  dashboard                             Local web dashboard for common admin tasks (HTTP on 127.0.0.1 by default)\n` +
      `  doctor [--fix]                        Inspect config drift, deprecated env vars, conflicting/stale overrides, and missing secrets; config-only, not Claude auth proof\n` +
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

function printClaudeHelp(write: (message: string) => void): void {
  write(
    `Usage: discoclaw claude <subcommand>\n` +
      `\nSubcommands:\n` +
      `  auth-smoke   Run one minimal Claude CLI prompt to verify the configured Claude binary can answer\n` +
      `\nNotes:\n` +
      `  - Loads .env first so CLAUDE_BIN is honored when set\n` +
      `  - Separate from \`discoclaw doctor\`, which remains config-only\n`,
  );
}

function printBrowserHelp(write: (message: string) => void): void {
  write(
    `Usage: discoclaw browser <subcommand>\n` +
      `\nSubcommands:\n` +
      `  setup                 Create the managed browser profile and print one-time login guidance\n` +
      `  doctor                Inspect browser readiness, storage enforcement, and managed-instance status\n` +
      `  launch [--headless]   Launch or reuse the managed browser profile after verified CDP handoff\n` +
      `\nFailure cases surfaced directly:\n` +
      `  - rejected in-repo custom data dirs\n` +
      `  - profile lock conflicts without a verified managed instance to reuse\n` +
      `  - cleanup failures after post-spawn verification errors\n`,
  );
}

function printBrowserReport(report: BrowserCliReport, write: (message: string) => void): void {
  write(report.summary);

  if (report.installMode) {
    write(`  Install mode: ${report.installMode}`);
  }
  if (report.storageRule) {
    write(`  Storage rule: ${report.storageRule}`);
  }
  if (report.executablePath !== undefined) {
    write(`  Browser executable: ${report.executablePath ?? 'not found'}`);
  }

  const pathEntries = Object.entries(report.paths ?? {}) as Array<[keyof NonNullable<BrowserCliReport['paths']>, string]>;
  for (const [key, value] of pathEntries) {
    write(`  ${formatBrowserPathLabel(key)}: ${value}`);
  }

  if (report.launch) {
    const launch = report.launch;
    if (launch.reusedExisting !== undefined) {
      write(`  Reused existing browser: ${launch.reusedExisting ? 'yes' : 'no'}`);
    }
    if (launch.headless !== undefined) {
      write(`  Headless: ${launch.headless ? 'yes' : 'no'}`);
    }
    if (launch.pid !== undefined) {
      write(`  PID: ${launch.pid}`);
    }
    if (launch.port !== undefined) {
      write(`  CDP port: ${launch.port}`);
    }
    if (launch.cdpUrl) {
      write(`  CDP endpoint: ${launch.cdpUrl}`);
    }
  }

  if ((report.issues?.length ?? 0) > 0) {
    write('');
    write('Issues:');
    for (const issue of report.issues ?? []) {
      write(`[${issue.severity.toUpperCase()}] ${issue.code}`);
      write(`  ${issue.message}`);
      if (issue.detail) {
        write(`  Detail: ${issue.detail}`);
      }
      if (issue.recommendation) {
        write(`  Recommended fix: ${issue.recommendation}`);
      }
    }
  }

  if ((report.nextSteps?.length ?? 0) > 0) {
    write('');
    write('Next steps:');
    for (const step of report.nextSteps ?? []) {
      write(`  - ${step}`);
    }
  }
}

function printBrowserCommandError(err: unknown, write: (message: string) => void): void {
  if (isBrowserCliReport((err as { report?: unknown } | null)?.report)) {
    printBrowserReport((err as { report: BrowserCliReport }).report, write);
    return;
  }

  if (isBrowserCliReport(err)) {
    printBrowserReport(err, write);
    return;
  }

  const error = err as { message?: unknown; detail?: unknown; recommendation?: unknown } | null;
  if (typeof error?.message === 'string' && error.message.length > 0) {
    write(error.message);
  } else {
    write(err instanceof Error ? err.message : String(err));
  }

  if (typeof error?.detail === 'string' && error.detail.length > 0) {
    write(`Detail: ${error.detail}`);
  }
  if (typeof error?.recommendation === 'string' && error.recommendation.length > 0) {
    write(`Recommended fix: ${error.recommendation}`);
  }
}

function formatBrowserPathLabel(key: keyof NonNullable<BrowserCliReport['paths']>): string {
  switch (key) {
    case 'dataDir':
      return 'Data dir';
    case 'profileDir':
      return 'Profile dir';
    case 'stateFile':
      return 'State file';
  }

  return key;
}

function isBrowserCliReport(value: unknown): value is BrowserCliReport {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowserCliReport>;
  return typeof candidate.ok === 'boolean' && typeof candidate.summary === 'string';
}

function previewClaudeOutput(value: string, maxLen = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLen
    ? normalized
    : `${normalized.slice(0, maxLen - 1)}...`;
}

function looksLikeClaudeAuthFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return [
    'auth',
    'authenticate',
    'authentication',
    'credential',
    'login',
    'log in',
    'logged out',
    'not logged in',
    'not authenticated',
    'sign in',
    'unauthenticated',
  ].some((pattern) => normalized.includes(pattern));
}

function looksLikeMissingClaudeBinary(result: ClaudeAuthSmokeCommandResult, claudeBin: string): boolean {
  if (result.errorCode === 'ENOENT') return true;

  const combined = `${result.stderr}\n${result.shortMessage ?? ''}`.toLowerCase();
  return combined.includes('enoent')
    || combined.includes('command not found')
    || combined.includes(`spawn ${claudeBin.toLowerCase()}`);
}

function classifyClaudeAuthSmokeResult(
  result: ClaudeAuthSmokeCommandResult,
  claudeBin: string,
): ClaudeAuthSmokeStatus {
  if (looksLikeMissingClaudeBinary(result, claudeBin)) return 'missing-cli';

  const combinedOutput = `${result.stdout}\n${result.stderr}\n${result.shortMessage ?? ''}`.trim();
  if (result.ok && previewClaudeOutput(result.stdout)) return 'authenticated';
  if (looksLikeClaudeAuthFailure(combinedOutput)) return 'unauthenticated';
  return 'failed';
}

async function runClaudeAuthSmokeCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ClaudeAuthSmokeCommandResult> {
  try {
    const result = await execa(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      reject: false,
      timeout: opts.timeoutMs,
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
      failed: result.failed,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const typed = error as {
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      timedOut?: unknown;
    };
    return {
      ok: false,
      exitCode: typeof typed.exitCode === 'number' ? typed.exitCode : 1,
      stdout: typeof typed.stdout === 'string' ? typed.stdout : '',
      stderr: typeof typed.stderr === 'string' ? typed.stderr : '',
      failed: true,
      timedOut: typed.timedOut === true,
      errorCode: typeof typed.code === 'string' ? typed.code : undefined,
      shortMessage: typeof typed.shortMessage === 'string'
        ? typed.shortMessage
        : typeof typed.message === 'string'
          ? typed.message
          : undefined,
    };
  }
}

async function runClaudeAuthSmoke(options: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  deps: ClaudeCliDeps;
}): Promise<number> {
  const claudeBin = (options.env.CLAUDE_BIN ?? '').trim() || 'claude';

  if (options.argv.includes('--help') || options.argv.includes('-h')) {
    printClaudeHelp(options.deps.log.log);
    return 0;
  }

  options.deps.log.log('\nDiscoclaw Claude auth smoke\n');
  options.deps.log.log(`  Running ${claudeBin} -p -- ${JSON.stringify(CLAUDE_AUTH_SMOKE_PROMPT)}`);
  options.deps.log.log('  This checks whether the current shell can reach an authenticated Claude CLI session.');

  const result = await options.deps.runClaudeFn(claudeBin, ['-p', '--', CLAUDE_AUTH_SMOKE_PROMPT], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: CLAUDE_AUTH_SMOKE_TIMEOUT_MS,
  });
  const status = classifyClaudeAuthSmokeResult(result, claudeBin);
  const combinedPreview = previewClaudeOutput(`${result.stdout}\n${result.stderr}\n${result.shortMessage ?? ''}`);

  switch (status) {
    case 'authenticated':
      options.deps.log.log('  Claude CLI answered the minimal prompt.');
      if (combinedPreview) options.deps.log.log(`    Output preview: ${combinedPreview}`);
      return 0;
    case 'unauthenticated':
      options.deps.log.error('  Claude CLI appears installed but not authenticated.');
      options.deps.log.error(`    Run \`${claudeBin}\` to complete login, then rerun this command.`);
      if (combinedPreview) options.deps.log.error(`    CLI output: ${combinedPreview}`);
      return 1;
    case 'missing-cli':
      options.deps.log.error(`  Claude CLI not found (looked for "${claudeBin}").`);
      options.deps.log.error('    Install Claude Code or set CLAUDE_BIN to the correct binary before rerunning this command.');
      if (combinedPreview) options.deps.log.error(`    Launch error: ${combinedPreview}`);
      return 1;
    default:
      options.deps.log.error('  Claude CLI smoke failed for a non-auth reason.');
      if (result.timedOut) options.deps.log.error(`    Timed out after ${CLAUDE_AUTH_SMOKE_TIMEOUT_MS} ms.`);
      if (combinedPreview) options.deps.log.error(`    CLI output: ${combinedPreview}`);
      return 1;
  }
}

function selectBrowserCliHandler(
  module: Record<string, unknown>,
  exportNames: string[],
): BrowserCliDeps['setup'] {
  for (const name of exportNames) {
    const candidate = module[name];
    if (typeof candidate === 'function') {
      return candidate as BrowserCliDeps['setup'];
    }
  }

  throw new Error(
    `Managed browser CLI integration is missing one of the expected exports: ${exportNames.join(', ')}`,
  );
}

async function importBrowserCliModule(specifier: string): Promise<Record<string, unknown>> {
  const dynamicImport = new Function('target', 'return import(target);') as (target: string) => Promise<unknown>;
  const module = await dynamicImport(specifier);
  if (!module || typeof module !== 'object') {
    throw new Error(`Managed browser CLI module '${specifier}' did not load correctly.`);
  }
  return module as Record<string, unknown>;
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
