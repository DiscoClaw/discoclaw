/**
 * Daemon installer for discoclaw.
 * Invoked by `discoclaw install-daemon`.
 * On Linux: writes a systemd user unit and enables it via systemctl.
 * On macOS: writes a launchd plist and loads it via launchctl.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// ── Package resolution ─────────────────────────────────────────────────────

/**
 * Resolves the package root directory.
 * At runtime this file lives at dist/cli/daemon-installer.js,
 * so package root is two directories up.
 */
export function resolvePackageRoot(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(selfDir, '..', '..');
}

// ── Rendering helpers ──────────────────────────────────────────────────────

/**
 * Parses a .env file into key-value pairs.
 * Skips blank lines and comment lines.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1);
    if (key) result[key] = val;
  }
  return result;
}

/**
 * Renders a systemd user unit file for discoclaw.
 * Uses EnvironmentFile for .env loading (native systemd feature).
 */
export function renderSystemdUnit(packageRoot: string, cwd: string): string {
  const entryPoint = path.join(packageRoot, 'dist', 'index.js');
  return [
    '[Unit]',
    'Description=DiscoClaw — personal AI orchestrator',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/usr/bin/node ${entryPoint}`,
    `WorkingDirectory=${cwd}`,
    `EnvironmentFile=${path.join(cwd, '.env')}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Renders a launchd plist for discoclaw.
 * Since launchd has no EnvironmentFile equivalent, env vars are baked in
 * from the parsed .env at install time.
 */
export function renderLaunchdPlist(
  packageRoot: string,
  cwd: string,
  envVars: Record<string, string>,
): string {
  const entryPoint = path.join(packageRoot, 'dist', 'index.js');
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${v}</string>`)
    .join('\n');

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    '\t<string>com.discoclaw.agent</string>',
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    '\t\t<string>/usr/bin/node</string>',
    `\t\t<string>${entryPoint}</string>`,
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t<string>${cwd}</string>`,
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
  ];
  if (envEntries) lines.push(envEntries);
  lines.push('\t</dict>');
  lines.push('\t<key>RunAtLoad</key>');
  lines.push('\t<true/>');
  lines.push('\t<key>KeepAlive</key>');
  lines.push('\t<true/>');
  lines.push('</dict>');
  lines.push('</plist>');
  lines.push('');
  return lines.join('\n');
}

// ── Platform installers ────────────────────────────────────────────────────

async function installSystemd(
  packageRoot: string,
  cwd: string,
  ask: (prompt: string) => Promise<string>,
): Promise<void> {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'discoclaw.service');

  if (fs.existsSync(servicePath)) {
    const answer = await ask(
      `Service file already exists at ${servicePath}. Overwrite? [y/N] `,
    );
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.\n');
      return;
    }
  }

  const unit = renderSystemdUnit(packageRoot, cwd);
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(servicePath, unit, 'utf8');
  console.log(`Wrote ${servicePath}\n`);

  console.log('Running systemctl --user daemon-reload...');
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload']);
  } catch (err) {
    console.error(`systemctl daemon-reload failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log('Enabling and starting discoclaw service...');
  try {
    execFileSync('systemctl', ['--user', 'enable', '--now', 'discoclaw']);
  } catch (err) {
    console.error(`systemctl enable/start failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log('DiscoClaw daemon installed and started.\n');
  console.log('Useful commands:');
  console.log('  journalctl --user -u discoclaw.service -f   # tail logs');
  console.log('  systemctl --user status discoclaw           # check status');
  console.log('  systemctl --user stop discoclaw             # stop the service');
  console.log('');
}

async function installLaunchd(
  packageRoot: string,
  cwd: string,
  envPath: string,
  ask: (prompt: string) => Promise<string>,
): Promise<void> {
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(agentsDir, 'com.discoclaw.agent.plist');

  if (fs.existsSync(plistPath)) {
    const answer = await ask(`Plist already exists at ${plistPath}. Overwrite? [y/N] `);
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.\n');
      return;
    }
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const envVars = parseEnvFile(envContent);
  const plist = renderLaunchdPlist(packageRoot, cwd, envVars);

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf8');
  console.log(`Wrote ${plistPath}\n`);

  console.log(
    'Note: On macOS, .env changes require re-running `discoclaw install-daemon`.\n' +
      '      Environment variables are baked into the plist at install time.\n',
  );

  const uid = process.getuid!();
  const target = `gui/${uid}/com.discoclaw.agent`;

  // Idempotent: bootout first (ignore failure if agent is not currently loaded)
  try {
    execFileSync('launchctl', ['bootout', target]);
  } catch {
    // Not currently loaded — that's fine
  }

  console.log('Running launchctl bootstrap...');
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  } catch (err) {
    console.error(`launchctl bootstrap failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log('DiscoClaw daemon installed and started.\n');
  console.log('Useful commands:');
  console.log("  log stream --predicate 'process == \"node\"'  # tail logs");
  console.log('  launchctl list com.discoclaw.agent           # check status');
  console.log(`  launchctl bootout ${target}  # stop and unload`);
  console.log('');
}

// ── Main entrypoint ────────────────────────────────────────────────────────

export async function runDaemonInstaller(): Promise<void> {
  if (!input.isTTY) {
    console.error('discoclaw install-daemon requires an interactive terminal.\n');
    process.exit(1);
  }

  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin') {
    console.error(
      `Unsupported platform: ${platform}. Only Linux (systemd) and macOS (launchd) are supported.\n`,
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const envPath = path.join(cwd, '.env');

  if (!fs.existsSync(envPath)) {
    console.error(
      `No .env found in ${cwd}.\nRun \`discoclaw init\` first to set up your configuration.\n`,
    );
    process.exit(1);
  }

  const packageRoot = resolvePackageRoot();
  const entryPoint = path.join(packageRoot, 'dist', 'index.js');

  if (!fs.existsSync(entryPoint)) {
    console.error(
      `Cannot find the bot runtime at ${entryPoint}.\n` +
        'Make sure the package is properly installed (try running `npm install -g discoclaw` again).\n',
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  const ask = (prompt: string): Promise<string> => rl.question(prompt);

  try {
    if (platform === 'linux') {
      await installSystemd(packageRoot, cwd, ask);
    } else {
      await installLaunchd(packageRoot, cwd, envPath, ask);
    }
  } finally {
    rl.close();
  }
}
