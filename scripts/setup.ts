#!/usr/bin/env tsx
/**
 * Interactive setup wizard for Discoclaw.
 * Guides the user through creating a .env file with validated inputs.
 *
 * Usage:  pnpm setup
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateDiscordToken, validateSnowflake, validateSnowflakes } from '../src/validate.js';
import { buildEnvContent, backupFileName } from './setup-lib.js';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env');

let rl: readline.Interface | null = null;
let canceled = false;
let completed = false;

function cleanup() {
  canceled = true;
  // Remove .env.tmp if it exists (incomplete write)
  try { fs.unlinkSync(path.join(root, '.env.tmp')); } catch { /* ignore */ }
  if (rl) {
    const toClose = rl;
    rl = null;
    toClose.close();
  }
  console.log('\n\nSetup canceled.\n');
  process.exit(1);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

if (!input.isTTY) {
  console.error('Setup requires an interactive terminal. Run: pnpm setup\n');
  process.exit(1);
}

rl = readline.createInterface({ input, output });
rl.on('close', () => {
  if (!canceled && !completed) cleanup();
});

console.log(`
Discoclaw Setup
===============
This wizard creates a .env file with your Discord bot configuration.
You'll need your bot token from https://discord.com/developers/applications
and your Tasks/Cron forum channel IDs from Discord.
`);

// --- Check existing .env ---
if (fs.existsSync(envPath)) {
  const existing = fs.readFileSync(envPath, 'utf8');
  const tokenMatch = existing.match(/^DISCORD_TOKEN=(.*)$/m);
  const idsMatch = existing.match(/^DISCORD_ALLOW_USER_IDS=(.*)$/m);

  console.log('Existing .env detected:');
  if (tokenMatch?.[1]) {
    const t = tokenMatch[1].trim();
    console.log(`  DISCORD_TOKEN = ${t.slice(0, 8)}...(masked)`);
  } else {
    console.log('  DISCORD_TOKEN = (not set)');
  }
  if (idsMatch?.[1]) {
    const ids = idsMatch[1].trim().split(/[,\s]+/).filter(Boolean);
    const masked = ids.map((id) => id.length > 6 ? `${id.slice(0, 3)}...${id.slice(-3)}` : '***');
    console.log(`  DISCORD_ALLOW_USER_IDS = ${masked.join(', ')}`);
  } else {
    console.log('  DISCORD_ALLOW_USER_IDS = (not set)');
  }
  console.log('');

  const overwrite = await ask('Overwrite with fresh config? [y/N] ');
  if (overwrite.toLowerCase() !== 'y') {
    console.log('Run pnpm setup after removing .env to reconfigure.\n');
    completed = true;
    rl.close();
    process.exit(0);
  }

  // Timestamped backup
  const bkName = backupFileName();
  const backupPath = path.join(root, bkName);
  fs.copyFileSync(envPath, backupPath);
  console.log(`  Backed up to ${bkName}\n`);
}

// --- Required values ---
const values: Record<string, string> = {};

values.DISCORD_TOKEN = await askValidated(
  'Discord bot token: ',
  (val) => {
    const r = validateDiscordToken(val);
    return r.valid ? null : (r.reason ?? 'Invalid token format');
  },
);

values.DISCORD_ALLOW_USER_IDS = await askValidated(
  'Allowed user IDs (comma-separated): ',
  (val) => {
    const r = validateSnowflakes(val);
    if (!val.trim()) return 'At least one user ID is required';
    if (!r.valid && r.invalidIds.length > 0) return `Invalid IDs: ${r.invalidIds.join(', ')}`;
    if (!r.valid) return 'At least one valid snowflake ID is required';
    return null;
  },
);

values.DISCOCLAW_TASKS_FORUM = await askValidated(
  'Tasks forum channel ID (required): ',
  (val) => validateSnowflake(val) ? null : 'Must be a 17-20 digit number',
);

values.DISCOCLAW_CRON_FORUM = await askValidated(
  'Agents forum channel ID (required): ',
  (val) => validateSnowflake(val) ? null : 'Must be a 17-20 digit number',
);

// --- Provider selection ---
console.log('\nSelect your AI provider:');
console.log('  1) Claude');
console.log('  2) Gemini');
console.log('  3) OpenAI');
console.log('  4) Codex');
const providerChoice = await askValidated(
  'Provider [1-4]: ',
  (val) => (['1', '2', '3', '4'].includes(val) ? null : 'Enter 1, 2, 3, or 4'),
);

if (providerChoice === '1') {
  values.PRIMARY_RUNTIME = 'claude';
  const skipPerms = await ask(
    'Enable CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS? (required for headless operation) [Y/n] ',
  );
  if (skipPerms.toLowerCase() !== 'n') {
    values.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS = '1';
  }
  const streamJson = await ask('Use stream-json output format? (smoother streaming) [Y/n] ');
  if (streamJson.toLowerCase() !== 'n') {
    values.CLAUDE_OUTPUT_FORMAT = 'stream-json';
  }
} else if (providerChoice === '2') {
  values.PRIMARY_RUNTIME = 'gemini';
  console.log('  Note: auth is handled by the gemini binary itself (run `gemini` to authenticate).');
  const gemBin = await askOptional('Gemini binary path [default: gemini]: ', () => null);
  values.GEMINI_BIN = gemBin || 'gemini';
  const gemModel = await askOptional('Gemini model [default: gemini-2.5-pro]: ', () => null);
  values.GEMINI_MODEL = gemModel || 'gemini-2.5-pro';
} else if (providerChoice === '3') {
  values.PRIMARY_RUNTIME = 'openai';
  console.log('  Note: the OpenAI adapter is HTTP-only.');
  values.OPENAI_API_KEY = await askValidated(
    'OpenAI API key: ',
    (val) => (val ? null : 'API key is required'),
  );
} else if (providerChoice === '4') {
  values.PRIMARY_RUNTIME = 'codex';
  const codexBin = await askOptional('Codex binary path [leave empty to use PATH]: ', () => null);
  if (codexBin) values.CODEX_BIN = codexBin;
  const codexModel = await askOptional('Codex model [leave empty for default]: ', () => null);
  if (codexModel) values.CODEX_MODEL = codexModel;
  const bypassApprovals = await ask('Enable CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX? [y/N] ');
  if (bypassApprovals.toLowerCase() === 'y') {
    values.CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX = '1';
  }
}

// --- Recommended values ---
const configRecommended = await ask('\nConfigure recommended settings? [Y/n] ');
if (configRecommended.toLowerCase() !== 'n') {
  const guildId = await askOptional(
    'Discord guild (server) ID [leave empty to skip]: ',
    (val) => {
      if (!val) return null;
      return validateSnowflake(val) ? null : 'Must be a 17-20 digit number';
    },
  );
  if (guildId) values.DISCORD_GUILD_ID = guildId;
}

// --- Optional features ---
const configOptional = await ask('\nConfigure optional features? [y/N] ');
if (configOptional.toLowerCase() === 'y') {
  const actions = await ask('Enable Discord Actions? (lets the AI manage your server) [y/N] ');
  if (actions.toLowerCase() === 'y') {
    values.DISCOCLAW_DISCORD_ACTIONS = '1';
  }

  const statusChannel = await askOptional(
    'Status channel ID or name [leave empty to skip]: ',
    () => null,
  );
  if (statusChannel) values.DISCOCLAW_STATUS_CHANNEL = statusChannel;
}

// --- Write .env atomically ---
const envContent = buildEnvContent(values);
const tmpPath = path.join(root, '.env.tmp');
fs.writeFileSync(tmpPath, envContent, 'utf8');
fs.renameSync(tmpPath, envPath);

console.log('\n.env written successfully.\n');

// --- Run preflight (Claude only) or print next-steps ---
if (values.PRIMARY_RUNTIME === 'claude') {
  console.log('Running pnpm preflight to validate...\n');
  try {
    execFileSync('pnpm', ['run', 'preflight'], { cwd: root, stdio: 'inherit' });
  } catch {
    console.log('\nPreflight reported issues above. Fix them and run pnpm preflight again.\n');
  }
  console.log('\nNext steps:');
  console.log('  pnpm build && pnpm dev\n');
} else {
  console.log('\nNext steps:');
  if (values.PRIMARY_RUNTIME === 'gemini') {
    console.log('  1. Authenticate with Gemini: run `gemini` and follow the prompts.');
  } else if (values.PRIMARY_RUNTIME === 'openai') {
    console.log('  1. Verify your OPENAI_API_KEY is correct.');
  } else if (values.PRIMARY_RUNTIME === 'codex') {
    console.log('  1. Ensure the Codex binary is installed and accessible.');
  }
  console.log('  2. pnpm build && pnpm dev\n');
}

completed = true;
rl.close();

// ---- Helper functions ----

async function ask(prompt: string): Promise<string> {
  if (canceled || !rl) return '';
  return rl.question(prompt);
}

async function askValidated(
  prompt: string,
  validate: (val: string) => string | null,
): Promise<string> {
  while (true) {
    if (canceled) return '';
    const val = await ask(prompt);
    const err = validate(val.trim());
    if (!err) return val.trim();
    console.log(`  Error: ${err}. Try again.\n`);
  }
}

async function askOptional(
  prompt: string,
  validate: (val: string) => string | null,
): Promise<string> {
  while (true) {
    if (canceled) return '';
    const val = await ask(prompt);
    if (!val.trim()) return '';
    const err = validate(val.trim());
    if (!err) return val.trim();
    console.log(`  Error: ${err}. Try again.\n`);
  }
}
