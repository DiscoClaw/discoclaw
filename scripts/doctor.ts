#!/usr/bin/env tsx
/**
 * Preflight check for Discoclaw — verifies the local prerequisites this command
 * can prove today. Exit 0 if every automated check passes, 1 if any check fails.
 *
 * Usage:  pnpm run preflight
 *         pnpm run preflight:blank-machine
 *         pnpm run preflight:online   (adds Discord connection test)
 *         pnpm run preflight:blank-machine:online
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { inspect } from '../src/health/config-doctor.js';
import { validateDiscordToken, validateSnowflake, validateSnowflakes } from '../src/validate.js';
import { missingEnvVars } from './doctor-env-diff.js';
import { checkRequiredForums, checkRuntimeBinaries, type DoctorCheckResult } from './doctor-lib.js';

const defaultRoot = path.resolve(import.meta.dirname, '..');

export const MIN_CLAUDE_VERSION = '2.1.0';
export const CLAUDE_BLANK_MACHINE_AUDIT_DOC = 'docs/audit/claude-blank-machine-readiness.md';

type DoctorLogFn = (line: string) => void;

type DoctorReporter = {
  ok: (label: string) => void;
  fail: (label: string, hint?: string) => void;
  info: (label: string) => void;
  failures: () => number;
};

type InspectResult = Awaited<ReturnType<typeof inspect>>;

export type DoctorDeps = {
  log?: DoctorLogFn;
  whichFn?: (bin: string) => string | null;
  versionOfFn?: (bin: string) => string | null;
  existsSync?: (filePath: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  inspectFn?: (opts: Parameters<typeof inspect>[0]) => Promise<InspectResult>;
  missingEnvVarsFn?: typeof missingEnvVars;
  checkRuntimeBinariesFn?: typeof checkRuntimeBinaries;
  checkRequiredForumsFn?: typeof checkRequiredForums;
  resolveHooksDir?: (cwd: string) => string;
  testDiscordConnectionFn?: (discordToken: string, reporter: DoctorReporter) => Promise<boolean>;
};

export type RunDoctorOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  deps?: DoctorDeps;
};

function defaultWhich(bin: string): string | null {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, [bin], { encoding: 'utf8' }).trim();
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function defaultVersionOf(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

function defaultResolveHooksDir(cwd: string): string {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return path.join(cwd, '.git', 'hooks');
  }
}

function parseSemver(versionStr: string): [number, number, number] | null {
  const match = versionStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(current: [number, number, number], minimum: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
}

function createReporter(log: DoctorLogFn): DoctorReporter {
  let failures = 0;

  return {
    ok(label: string) {
      log(`  ✓ ${label}`);
    },
    fail(label: string, hint?: string) {
      log(`  ✗ ${label}`);
      if (hint) log(`    → ${hint}`);
      failures++;
    },
    info(label: string) {
      log(`  ℹ ${label}`);
    },
    failures() {
      return failures;
    },
  };
}

function loadEnvFile(
  envPath: string,
  existsSync: (filePath: string) => boolean,
  readFileSync: typeof fs.readFileSync,
): NodeJS.ProcessEnv {
  if (!existsSync(envPath)) return {};
  return dotenv.parse(readFileSync(envPath, 'utf8'));
}

function emitDoctorContractNotes(log: DoctorReporter, blankMachine: boolean) {
  log.info('This check only reports prerequisites Discoclaw can verify locally today.');
  if (blankMachine) {
    log.info('Blank-machine mode is active: ignoring inherited shell env and reading only the current .env values.');
  }
  log.info('Forum IDs may be bootstrap-derived: persisted scaffold state or first-connect creation via DISCORD_GUILD_ID can satisfy them when env vars are unset.');
  log.info('Claude auth is a manual validation step; this command does not auto-check Claude login state.');
  log.info(`Follow the manual pre-login and post-login validation in ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.`);
}

function emitCheckResult(check: DoctorCheckResult, reporter: DoctorReporter) {
  if (check.info) reporter.info(check.label);
  else if (check.ok) reporter.ok(check.label);
  else reporter.fail(check.label, check.hint);
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<number> {
  const {
    cwd = defaultRoot,
    env: baseEnv = process.env,
    argv = process.argv,
    deps = {},
  } = options;

  const log = deps.log ?? console.log;
  const reporter = createReporter(log);
  const whichFn = deps.whichFn ?? defaultWhich;
  const versionOfFn = deps.versionOfFn ?? defaultVersionOf;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const inspectFn = deps.inspectFn ?? inspect;
  const missingEnvVarsFn = deps.missingEnvVarsFn ?? missingEnvVars;
  const checkRuntimeBinariesFn = deps.checkRuntimeBinariesFn ?? checkRuntimeBinaries;
  const checkRequiredForumsFn = deps.checkRequiredForumsFn ?? checkRequiredForums;
  const resolveHooksDir = deps.resolveHooksDir ?? defaultResolveHooksDir;
  const testDiscordConnectionFn = deps.testDiscordConnectionFn ?? defaultTestDiscordConnection;

  const checkConnection = argv.includes('--check-connection');
  const blankMachine = argv.includes('--blank-machine');
  const envPath = path.join(cwd, '.env');
  const envFile = loadEnvFile(envPath, existsSync, readFileSync);
  const env: NodeJS.ProcessEnv = blankMachine
    ? { ...envFile }
    : { ...baseEnv, ...envFile };

  log('\nDiscoclaw preflight check\n');
  emitDoctorContractNotes(reporter, blankMachine);

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (nodeMajor >= 20) {
    reporter.ok(`Node.js v${nodeVersion}`);
  } else {
    reporter.fail(`Node.js v${nodeVersion} (need >=20)`, 'Install Node.js 20+ from https://nodejs.org');
  }

  const pnpmVersion = versionOfFn('pnpm');
  if (pnpmVersion) {
    reporter.ok(`pnpm ${pnpmVersion}`);
  } else {
    reporter.fail('pnpm not found', 'Run: corepack enable  (or install pnpm globally)');
  }

  const claudeBin = (env.CLAUDE_BIN ?? '').trim() || 'claude';
  for (const check of checkRuntimeBinariesFn(env, whichFn)) {
    emitCheckResult(check, reporter);

    if (check.ok && !check.info && check.label.startsWith('Claude CLI found')) {
      const claudeVersion = versionOfFn(claudeBin);
      if (claudeVersion) {
        const parsed = parseSemver(claudeVersion);
        const minParsed = parseSemver(MIN_CLAUDE_VERSION)!;
        if (parsed) {
          if (isVersionAtLeast(parsed, minParsed)) {
            reporter.ok(`Claude CLI version >= ${MIN_CLAUDE_VERSION}`);
          } else {
            reporter.fail(
              `Claude CLI version ${parsed.join('.')} < ${MIN_CLAUDE_VERSION}`,
              'Glob/Grep/Write tools and --fallback-model/--max-budget-usd/--append-system-prompt flags require a newer Claude CLI. Run: claude update',
            );
          }
        } else {
          reporter.info(`Could not parse Claude CLI version from "${claudeVersion}" (forward-compat: continuing)`);
        }
      }
    }
  }

  const hooksDir = resolveHooksDir(cwd);
  const prePushHook = path.join(hooksDir, 'pre-push');
  if (existsSync(prePushHook)) {
    reporter.ok('pre-push hook installed');
  } else {
    reporter.info('pre-push hook not installed (run: pnpm install)');
  }

  const wsDir = env.WORKSPACE_CWD
    || (env.DISCOCLAW_DATA_DIR ? path.join(env.DISCOCLAW_DATA_DIR, 'workspace') : path.join(cwd, 'workspace'));
  const permPath = path.join(wsDir, 'PERMISSIONS.json');
  if (existsSync(permPath)) {
    try {
      const permRaw = JSON.parse(readFileSync(permPath, 'utf8'));
      const tier = typeof permRaw?.tier === 'string' ? permRaw.tier : undefined;
      if (tier && ['readonly', 'standard', 'full', 'custom'].includes(tier)) {
        reporter.ok(`PERMISSIONS.json: tier=${tier}`);
      } else {
        reporter.fail('PERMISSIONS.json exists but is malformed', `Invalid tier: ${JSON.stringify(permRaw?.tier)}`);
      }
    } catch {
      reporter.fail('PERMISSIONS.json exists but is not valid JSON');
    }
  } else {
    reporter.info('PERMISSIONS.json not found (will use env/default tools until onboarding runs)');
  }

  if (existsSync(envPath)) {
    reporter.ok('.env file exists');

    const examplePath = path.join(cwd, '.env.example');
    if (existsSync(examplePath)) {
      const missing = missingEnvVarsFn(
        readFileSync(examplePath, 'utf8'),
        readFileSync(envPath, 'utf8'),
      );
      if (missing.length === 0) {
        reporter.ok('.env covers all .env.example vars');
      } else {
        reporter.info(`${missing.length} var(s) in .env.example not in your .env: ${missing.join(', ')}`);
        log('    → See .env.example for descriptions');
      }
    } else {
      reporter.info('.env.example not found — skipping env coverage check');
    }
  } else {
    reporter.fail('.env file missing', 'Run: cp .env.example .env  (or pnpm run setup for guided configuration)');
  }

  const token = (env.DISCORD_TOKEN ?? '').trim();
  const allowUserIds = (env.DISCORD_ALLOW_USER_IDS ?? '').trim();

  if (token) reporter.ok('DISCORD_TOKEN is set');
  else reporter.fail('DISCORD_TOKEN is empty or missing');

  if (allowUserIds) reporter.ok('DISCORD_ALLOW_USER_IDS is set');
  else reporter.fail('DISCORD_ALLOW_USER_IDS is empty or missing');

  if (token) {
    const tokenResult = validateDiscordToken(token);
    if (tokenResult.valid) {
      reporter.ok('DISCORD_TOKEN format valid (3 dot-separated base64url segments)');
    } else {
      reporter.fail(
        `DISCORD_TOKEN format invalid: ${tokenResult.reason}`,
        'Copy the full bot token from Discord Developer Portal → Bot → Reset Token',
      );
    }
  }

  if (allowUserIds) {
    const idsResult = validateSnowflakes(allowUserIds);
    if (idsResult.valid) {
      reporter.ok('DISCORD_ALLOW_USER_IDS format valid (all snowflakes)');
    } else {
      reporter.fail(
        `DISCORD_ALLOW_USER_IDS contains invalid IDs: ${idsResult.invalidIds.join(', ')}`,
        'User IDs must be 17-20 digit numbers. Right-click user → Copy ID (enable Developer Mode in Discord settings)',
      );
    }
  }

  const guildId = (env.DISCORD_GUILD_ID ?? '').trim();
  if (guildId) {
    if (validateSnowflake(guildId)) {
      reporter.ok('DISCORD_GUILD_ID format valid');
    } else {
      reporter.fail('DISCORD_GUILD_ID is not a valid snowflake', 'Must be a 17-20 digit number. Right-click server name → Copy Server ID');
    }
  }

  const channelIds = (env.DISCORD_CHANNEL_IDS ?? '').trim();
  if (channelIds) {
    const channelResult = validateSnowflakes(channelIds);
    if (channelResult.valid) {
      reporter.ok('DISCORD_CHANNEL_IDS format valid');
    } else {
      reporter.fail(
        `DISCORD_CHANNEL_IDS contains invalid IDs: ${channelResult.invalidIds.join(', ')}`,
        'Channel IDs must be 17-20 digit numbers. Right-click channel → Copy Channel ID',
      );
    }
  }

  for (const check of checkRequiredForumsFn(env)) {
    emitCheckResult(check, reporter);
  }

  const doctorReport = await inspectFn({ cwd, env });
  if (doctorReport.findings.length === 0) {
    reporter.ok('Config doctor found no config drift');
  } else {
    for (const finding of doctorReport.findings) {
      const label = `Config doctor [${finding.severity}] ${finding.message}`;
      const hint = finding.autoFixable
        ? `${finding.recommendation} Auto-fixable via: discoclaw doctor --fix`
        : finding.recommendation;

      if (finding.severity === 'info') reporter.ok(label);
      else reporter.fail(label, hint);
    }
  }

  if (checkConnection) {
    log('\n  Discord connection test...');

    if (!token) {
      reporter.fail('Cannot test connection — DISCORD_TOKEN is not set');
    } else {
      await testDiscordConnectionFn(token, reporter);
    }
  }

  log('');
  if (reporter.failures() === 0) {
    log('All automated checks passed.');
    log(`Claude auth still requires the manual validation in ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.\n`);
    return 0;
  }

  log(`${reporter.failures()} automated check(s) failed.`);
  log(`Claude auth still requires the manual validation in ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.\n`);
  return 1;
}

async function defaultTestDiscordConnection(discordToken: string, reporter: DoctorReporter): Promise<boolean> {
  const { Client, GatewayIntentBits, Partials } = await import('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (success: boolean, fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
      client.destroy();
      resolve(success);
    };

    const timeout = setTimeout(() => {
      settle(false, () => {
        reporter.fail('Discord connection timed out after 10s', 'Check your network connection and DISCORD_TOKEN');
      });
    }, 10_000);

    client.on('shardError', (err) => {
      settle(false, () => {
        reporter.fail(`Discord shard error: ${err.message}`);
      });
    });

    client.on('shardDisconnect', (event: { code: number }) => {
      if (event.code === 4014) {
        settle(false, () => {
          reporter.fail(
            'Discord gateway closed with code 4014 (Disallowed Intents)',
            'Enable Message Content Intent in Developer Portal → Bot → Privileged Gateway Intents',
          );
        });
      }
    });

    client.once('ready', () => {
      settle(true, () => {
        const guildCount = client.guilds.cache.size;
        reporter.ok(`Discord connection successful (guilds: ${guildCount})`);
        reporter.ok('Message Content Intent is enabled');
      });
    });

    client.login(discordToken).catch((err: Error) => {
      settle(false, () => {
        const msg = err.message ?? String(err);
        if (msg.includes('TOKEN_INVALID') || msg.includes('An invalid token was provided')) {
          reporter.fail('Discord login failed: invalid token', 'Reset the token in Developer Portal → Bot → Reset Token');
        } else {
          reporter.fail(`Discord login failed: ${msg}`);
        }
      });
    });
  });
}

function isMainModule(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return path.resolve(argvPath) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const exitCode = await runDoctor();
  process.exit(exitCode);
}
