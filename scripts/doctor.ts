#!/usr/bin/env tsx
/**
 * Preflight check for Discoclaw — verifies that the local environment is
 * ready to run.  Exit 0 if everything passes, 1 if any check fails.
 *
 * Usage:  pnpm doctor
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
    return execSync(`which ${bin}`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function versionOf(bin: string): string | null {
  try {
    return execSync(`${bin} --version`, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

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

// 3. Claude CLI
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const claudePath = which(claudeBin);
if (claudePath) {
  const claudeVersion = versionOf(claudeBin);
  ok(`Claude CLI: ${claudeVersion ?? claudePath}`);
} else {
  fail(`Claude CLI not found (looked for "${claudeBin}")`, 'Install from https://docs.anthropic.com/en/docs/claude-code');
}

// 3b. bd CLI (informational — beads is default-on)
const bdBin = process.env.BD_BIN || 'bd';
const bdPath = which(bdBin);
if (bdPath) {
  ok(`bd CLI: ${bdPath}`);
} else {
  console.log(`  ℹ bd CLI not found (beads task tracking will be inactive until bd is installed)`);
}

// 4. .env exists
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  ok('.env file exists');
} else {
  fail('.env file missing', 'Run: cp .env.example .env');
}

// 5. Required env vars
const requiredVars = ['DISCORD_TOKEN', 'DISCORD_ALLOW_USER_IDS'];
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const varName of requiredVars) {
    const match = envContent.match(new RegExp(`^${varName}=(.+)`, 'm'));
    if (match && match[1].trim()) {
      ok(`${varName} is set`);
    } else {
      fail(`${varName} is empty or missing in .env`);
    }
  }
} else {
  for (const varName of requiredVars) {
    fail(`${varName} — cannot check (.env missing)`);
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
