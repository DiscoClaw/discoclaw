#!/usr/bin/env node
/**
 * discoclaw CLI entrypoint.
 * Usage: discoclaw <command> [options]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { runInitWizard } from './init-wizard.js';
import { runDaemonInstaller } from './daemon-installer.js';
import type { DoctorFinding, DoctorReport, FixResult } from '../health/config-doctor.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const [, , command] = process.argv;

switch (command) {
  case 'init':
    await runInitWizard();
    break;
  case 'install-daemon':
    await runDaemonInstaller();
    break;
  case 'dashboard': {
    const cwd = process.cwd();
    const { config } = await import('dotenv');
    const { startDashboardServer } = await import('../dashboard/server.js');
    const { DASHBOARD_HOST, parseDashboardPort } = await import('../dashboard/options.js');

    config({ path: path.join(cwd, '.env') });

    try {
      const port = parseDashboardPort(process.env);
      const handle = await startDashboardServer({
        cwd,
        env: process.env,
        host: DASHBOARD_HOST,
        port,
      });
      const address = handle.server.address() as { port: number } | null;
      const boundPort = address?.port ?? port;
      console.log(`Discoclaw dashboard listening at http://${DASHBOARD_HOST}:${boundPort}/`);
      console.log('Press Ctrl+C to stop.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }
  case 'doctor': {
    const cwd = process.cwd();
    const shouldFix = process.argv.includes('--fix');
    const { config } = await import('dotenv');
    const { inspect, applyFixes } = await import('../health/config-doctor.js');

    config({ path: path.join(cwd, '.env') });

    const report = await inspect({ cwd, env: process.env });
    printDoctorReport(report);

    if (shouldFix) {
      const result = await applyFixes(report, { cwd, env: process.env });
      printDoctorFixResult(result);
    }
    break;
  }
  case 'update': {
    const subcommand = process.argv[3];
    const { isNpmManaged, getLocalVersion, getLatestNpmVersion, npmGlobalUpgrade } =
      await import('../npm-managed.js');
    const npmMode = await isNpmManaged();

    if (subcommand === 'apply') {
      if (!npmMode) {
        console.error('This instance is not npm-managed. Use the git-based workflow to update.');
        process.exit(1);
      }
      console.log('Installing latest version from npm...');
      const result = await npmGlobalUpgrade();
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 500);
        console.error(`npm install -g discoclaw failed:\n${detail}`);
        process.exit(1);
      }
      console.log('Update complete. Restart discoclaw to run the new version.');
    } else if (subcommand === undefined) {
      if (!npmMode) {
        console.log('This instance is not npm-managed; update checking is not supported in this mode.');
        break;
      }
      const installed = getLocalVersion();
      const latest = await getLatestNpmVersion();
      if (latest === null) {
        console.error('Failed to fetch latest version from npm registry.');
        process.exit(1);
      }
      if (installed === latest) {
        console.log(`Already on latest version (${installed}).`);
      } else {
        console.log(`Update available: ${installed} → ${latest}. Run \`discoclaw update apply\` to upgrade.`);
      }
    } else {
      console.error(`Unknown update subcommand: ${subcommand}\n`);
      printHelp(version);
      process.exit(1);
    }
    break;
  }
  case '--version':
  case '-v':
    console.log(version);
    break;
  case '--help':
  case '-h':
  case undefined:
    printHelp(version);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    printHelp(version);
    process.exit(1);
}

function printHelp(ver: string): void {
  console.log(
    `discoclaw v${ver} — Personal AI orchestrator\n` +
      `\nUsage: discoclaw <command>\n` +
      `\nCommands:\n` +
      `  init                                  Interactive setup wizard — creates .env and workspace/\n` +
      `  dashboard                             Local web dashboard for common admin tasks (HTTP on 127.0.0.1)\n` +
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
