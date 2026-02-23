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
      `\nOptions:\n` +
      `  -v, --version   Print version\n` +
      `  -h, --help      Print this help\n`,
  );
}
