#!/usr/bin/env node
/**
 * discoclaw CLI entrypoint.
 * Usage: discoclaw <command> [options]
 */

import { createRequire } from 'node:module';
import { runInitWizard } from './init-wizard.js';
import { runDaemonInstaller } from './daemon-installer.js';

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
