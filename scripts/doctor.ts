#!/usr/bin/env tsx
/**
 * Preflight check for Discoclaw — verifies that the local environment is
 * ready to run.  Exit 0 if everything passes, 1 if any check fails.
 *
 * Usage:  pnpm run preflight
 *         pnpm run preflight:online   (adds Discord connection test)
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateDiscordToken, validateSnowflake, validateSnowflakes } from '../src/validate.js';
import { missingEnvVars } from './doctor-env-diff.js';
import { checkRequiredForums, checkRuntimeBinaries } from './doctor-lib.js';

const root = path.resolve(import.meta.dirname, '..');

let failures = 0;

function ok(label: string) {
  console.log(`  ✓ ${label}`);
}

function fail(label: string, hint?: string) {
  console.log(`  ✗ ${label}`);
  if (hint) console.log(`    → ${hint}`);
  failures++;
}

function which(bin: string): string | null {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, [bin], { encoding: 'utf8' }).trim();
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function versionOf(bin: string): string | null {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

const MIN_CLAUDE_VERSION = '2.1.0';

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
  return true; // equal
}

const checkConnection = process.argv.includes('--check-connection');

console.log('\nDiscoclaw preflight check\n');

// 1. Node.js
const nodeVersion = process.versions.node;
const nodeMajor = Number(nodeVersion.split('.')[0]);
if (nodeMajor >= 20) {
  ok(`Node.js v${nodeVersion}`);
} else {
  fail(`Node.js v${nodeVersion} (need >=20)`, 'Install Node.js 20+ from https://nodejs.org');
}

// 2. pnpm
const pnpmVersion = versionOf('pnpm');
if (pnpmVersion) {
  ok(`pnpm ${pnpmVersion}`);
} else {
  fail('pnpm not found', 'Run: corepack enable  (or install pnpm globally)');
}

// 3. Runtime CLI binaries (Claude, Gemini, Codex, and OpenAI)
const claudeBin = (process.env.CLAUDE_BIN ?? '').trim() || 'claude';
for (const check of checkRuntimeBinaries(process.env, which)) {
  if (check.info) {
    console.log(`  ℹ ${check.label}`);
  } else if (check.ok) {
    ok(check.label);
  } else {
    fail(check.label, check.hint);
  }

  // Claude-specific version sub-check (only when Claude CLI was found)
  if (check.ok && !check.info && check.label.startsWith('Claude CLI found')) {
    const claudeVersion = versionOf(claudeBin);
    if (claudeVersion) {
      const parsed = parseSemver(claudeVersion);
      const minParsed = parseSemver(MIN_CLAUDE_VERSION)!;
      if (parsed) {
        if (isVersionAtLeast(parsed, minParsed)) {
          ok(`Claude CLI version >= ${MIN_CLAUDE_VERSION}`);
        } else {
          fail(
            `Claude CLI version ${parsed.join('.')} < ${MIN_CLAUDE_VERSION}`,
            `Glob/Grep/Write tools and --fallback-model/--max-budget-usd/--append-system-prompt flags require >= ${MIN_CLAUDE_VERSION}. Run: claude update`,
          );
        }
      } else {
        console.log(`  ℹ Could not parse Claude CLI version from "${claudeVersion}" (forward-compat: continuing)`);
      }
    }
  }
}

// 4. Pre-push hook (informational)
const hooksDir = (() => {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
  } catch {
    return path.join(root, '.git', 'hooks');
  }
})();
const prePushHook = path.join(hooksDir, 'pre-push');
if (fs.existsSync(prePushHook)) {
  ok('pre-push hook installed');
} else {
  console.log('  ℹ pre-push hook not installed (run: pnpm install)');
}

// 5. workspace/PERMISSIONS.json (informational)
const wsDir = process.env.WORKSPACE_CWD
  || (process.env.DISCOCLAW_DATA_DIR ? path.join(process.env.DISCOCLAW_DATA_DIR, 'workspace') : path.join(root, 'workspace'));
const permPath = path.join(wsDir, 'PERMISSIONS.json');
if (fs.existsSync(permPath)) {
  try {
    const permRaw = JSON.parse(fs.readFileSync(permPath, 'utf8'));
    const tier = typeof permRaw?.tier === 'string' ? permRaw.tier : undefined;
    if (tier && ['readonly', 'standard', 'full', 'custom'].includes(tier)) {
      ok(`PERMISSIONS.json: tier=${tier}`);
    } else {
      fail('PERMISSIONS.json exists but is malformed', `Invalid tier: ${JSON.stringify(permRaw?.tier)}`);
    }
  } catch {
    fail('PERMISSIONS.json exists but is not valid JSON');
  }
} else {
  console.log('  ℹ PERMISSIONS.json not found (will use env/default tools until onboarding runs)');
}

// 6. .env exists
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  ok('.env file exists');

  // 6b. Env var coverage (informational only — never fails)
  const examplePath = path.join(root, '.env.example');
  if (fs.existsSync(examplePath)) {
    const missing = missingEnvVars(
      fs.readFileSync(examplePath, 'utf8'),
      fs.readFileSync(envPath, 'utf8'),
    );
    if (missing.length === 0) {
      ok('.env covers all .env.example vars');
    } else {
      console.log(`  ℹ ${missing.length} var(s) in .env.example not in your .env: ${missing.join(', ')}`);
      console.log('    → See .env.example for descriptions');
    }
  } else {
    console.log('  ℹ .env.example not found — skipping env coverage check');
  }
} else {
  fail('.env file missing', 'Run: cp .env.example .env  (or pnpm setup for guided configuration)');
}

// 7. Required env vars (read from process.env — dotenv already loaded at top)
const token = (process.env.DISCORD_TOKEN ?? '').trim();
const allowUserIds = (process.env.DISCORD_ALLOW_USER_IDS ?? '').trim();

if (token) {
  ok('DISCORD_TOKEN is set');
} else {
  fail('DISCORD_TOKEN is empty or missing');
}

if (allowUserIds) {
  ok('DISCORD_ALLOW_USER_IDS is set');
} else {
  fail('DISCORD_ALLOW_USER_IDS is empty or missing');
}

// 8. Token format validation
if (token) {
  const tokenResult = validateDiscordToken(token);
  if (tokenResult.valid) {
    ok('DISCORD_TOKEN format valid (3 dot-separated base64url segments)');
  } else {
    fail(`DISCORD_TOKEN format invalid: ${tokenResult.reason}`, 'Copy the full bot token from Discord Developer Portal → Bot → Reset Token');
  }
}

// 9. Snowflake format validation
if (allowUserIds) {
  const idsResult = validateSnowflakes(allowUserIds);
  if (idsResult.valid) {
    ok('DISCORD_ALLOW_USER_IDS format valid (all snowflakes)');
  } else {
    fail(
      `DISCORD_ALLOW_USER_IDS contains invalid IDs: ${idsResult.invalidIds.join(', ')}`,
      'User IDs must be 17-20 digit numbers. Right-click user → Copy ID (enable Developer Mode in Discord settings)',
    );
  }
}

const guildId = (process.env.DISCORD_GUILD_ID ?? '').trim();
if (guildId) {
  if (validateSnowflake(guildId)) {
    ok('DISCORD_GUILD_ID format valid');
  } else {
    fail('DISCORD_GUILD_ID is not a valid snowflake', 'Must be a 17-20 digit number. Right-click server name → Copy Server ID');
  }
}

const channelIds = (process.env.DISCORD_CHANNEL_IDS ?? '').trim();
if (channelIds) {
  const channelResult = validateSnowflakes(channelIds);
  if (channelResult.valid) {
    ok('DISCORD_CHANNEL_IDS format valid');
  } else {
    fail(
      `DISCORD_CHANNEL_IDS contains invalid IDs: ${channelResult.invalidIds.join(', ')}`,
      'Channel IDs must be 17-20 digit numbers. Right-click channel → Copy Channel ID',
    );
  }
}

// 10. Required subsystem forums (runtime blockers)
for (const check of checkRequiredForums(process.env)) {
  if (check.ok) ok(check.label);
  else fail(check.label, check.hint);
}

// 11. Task store migration state
{
  const tasksCwd = (process.env.DISCOCLAW_TASKS_CWD ?? '').trim() || process.cwd();
  const dataDir = (process.env.DISCOCLAW_DATA_DIR ?? '').trim();
  const tasksDataDir = dataDir
    ? path.join(dataDir, 'tasks')
    : path.join(root, 'data', 'tasks');
  const legacyDbPath = path.join(tasksCwd, '.beads', 'beads.db');
  const tasksJsonlPath = path.join(tasksDataDir, 'tasks.jsonl');
  const legacyExists = fs.existsSync(legacyDbPath);
  const jsonlExists = fs.existsSync(tasksJsonlPath);

  if (!legacyExists && !jsonlExists) {
    // Fresh install — nothing to check
  } else if (jsonlExists) {
    ok('Task store migrated (tasks.jsonl present)');
  } else {
    // Legacy DB exists but JSONL is missing
    fail(
      'Legacy bd database found but tasks.jsonl is missing',
      `Run migration — see docs/tasks-migration.md  (output: ${tasksJsonlPath})`,
    );
  }
}

// 12. Discord connection test (--check-connection only)
if (checkConnection) {
  console.log('\n  Discord connection test...');

  if (!token) {
    fail('Cannot test connection — DISCORD_TOKEN is not set');
  } else {
    await testDiscordConnection(token);
  }
}

// Summary
console.log('');
if (failures === 0) {
  console.log('All checks passed.\n');
  process.exit(0);
} else {
  console.log(`${failures} check(s) failed.\n`);
  process.exit(1);
}

async function testDiscordConnection(discordToken: string): Promise<boolean> {
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
        fail('Discord connection timed out after 10s', 'Check your network connection and DISCORD_TOKEN');
      });
    }, 10_000);

    // Listen for shard errors (including 4014 Disallowed Intents)
    client.on('shardError', (err) => {
      settle(false, () => {
        fail(`Discord shard error: ${err.message}`);
      });
    });

    client.on('shardDisconnect', (event: { code: number }) => {
      if (event.code === 4014) {
        settle(false, () => {
          fail(
            'Discord gateway closed with code 4014 (Disallowed Intents)',
            'Enable Message Content Intent in Developer Portal → Bot → Privileged Gateway Intents',
          );
        });
      }
    });

    client.once('ready', () => {
      settle(true, () => {
        const guildCount = client.guilds.cache.size;
        ok(`Discord connection successful (guilds: ${guildCount})`);
        ok('Message Content Intent is enabled');
      });
    });

    client.login(discordToken).catch((err: Error) => {
      settle(false, () => {
        const msg = err.message ?? String(err);
        if (msg.includes('TOKEN_INVALID') || msg.includes('An invalid token was provided')) {
          fail('Discord login failed: invalid token', 'Reset the token in Developer Portal → Bot → Reset Token');
        } else {
          fail(`Discord login failed: ${msg}`);
        }
      });
    });
  });
}
