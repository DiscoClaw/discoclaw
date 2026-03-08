import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import os from 'node:os';

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type ServiceAction = 'status' | 'logs' | 'restart';

export type ServiceCommands = {
  statusCmd: [string, string[]];
  logsCmd: [string, string[]];
  checkActiveCmd: [string, string[]];
  isActive: (result: CommandResult) => boolean;
  restartCmd: (wasActive: boolean) => [string, string[]];
};

export type ServiceControlDeps = {
  runCommand: (cmd: string, args: string[]) => Promise<CommandResult>;
  platform: NodeJS.Platform;
  homeDir: string;
  getUid: () => number;
};

function mapExitCode(err: ExecFileException | null): number | null {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : null;
}

export function normalizeServiceName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'discoclaw';
}

export function getServiceCommands(
  serviceName = 'discoclaw',
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
  uid = process.getuid?.() ?? 501,
): ServiceCommands | null {
  if (platform === 'linux') {
    return {
      statusCmd: ['systemctl', ['--user', 'status', serviceName]],
      logsCmd: ['journalctl', ['--user', '-u', serviceName, '--no-pager', '-n', '30']],
      checkActiveCmd: ['systemctl', ['--user', 'status', serviceName]],
      isActive: (result) => result.stdout.includes('active (running)'),
      restartCmd: () => ['systemctl', ['--user', 'restart', serviceName]],
    };
  }

  if (platform === 'darwin') {
    const label = `com.discoclaw.${serviceName}`;
    const plistPath = `${homeDir}/Library/LaunchAgents/${label}.plist`;
    const domain = `gui/${uid}`;
    return {
      statusCmd: ['launchctl', ['list', label]],
      logsCmd: ['log', ['show', '--predicate', 'process == "node"', '--last', '5m', '--style', 'compact']],
      checkActiveCmd: ['launchctl', ['list', label]],
      isActive: (result) => result.exitCode === 0,
      restartCmd: (wasActive) => (
        wasActive
          ? ['launchctl', ['kickstart', '-k', `${domain}/${label}`]]
          : ['launchctl', ['bootstrap', domain, plistPath]]
      ),
    };
  }

  return null;
}

export function getPlatformCommands(serviceName = 'discoclaw'): ServiceCommands | null {
  return getServiceCommands(serviceName, process.platform, os.homedir(), process.getuid?.() ?? 501);
}

export function run(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: mapExitCode(err),
      });
    });
  });
}

export function summarizeServiceStatus(
  result: CommandResult,
  platform: NodeJS.Platform,
): string {
  const outputText = (result.stdout || result.stderr).trim();
  if (!outputText) {
    return result.exitCode === 0 ? 'status available' : 'status unavailable';
  }

  if (platform === 'linux') {
    const activeMatch = outputText.match(/^\s*Active:\s+(.+)$/m);
    if (activeMatch) return activeMatch[1].trim();
  }

  const firstLine = outputText.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? 'status unavailable';
}

export function truncateCommandOutput(text: string, maxChars = 4000): string {
  const trimmed = text.trim();
  if (!trimmed) return '(no output)';
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 15)}\n[output truncated]`;
}

export async function runServiceAction(
  action: ServiceAction,
  serviceName: string,
  deps: ServiceControlDeps,
): Promise<string> {
  const commands = getServiceCommands(serviceName, deps.platform, deps.homeDir, deps.getUid());
  if (!commands) {
    return `Service actions are not supported on ${deps.platform}.`;
  }

  if (action === 'status') {
    const result = await deps.runCommand(commands.statusCmd[0], commands.statusCmd[1]);
    return truncateCommandOutput(result.stdout || result.stderr);
  }

  if (action === 'logs') {
    const result = await deps.runCommand(commands.logsCmd[0], commands.logsCmd[1]);
    return truncateCommandOutput(result.stdout || result.stderr);
  }

  const before = await deps.runCommand(commands.checkActiveCmd[0], commands.checkActiveCmd[1]);
  const wasActive = commands.isActive(before);
  const [cmd, args] = commands.restartCmd(wasActive);
  const result = await deps.runCommand(cmd, args);
  const detail = truncateCommandOutput(
    result.stdout || result.stderr || (result.exitCode === 0 ? 'Command completed.' : 'No output.'),
  );
  if (result.exitCode === 0) {
    return wasActive
      ? `Restart requested for ${serviceName}.\n\n${detail}`
      : `Start requested for ${serviceName}.\n\n${detail}`;
  }

  return `Service action failed for ${serviceName} (exit ${result.exitCode ?? 'unknown'}).\n\n${detail}`;
}

export async function probeServiceSummary(
  serviceName: string,
  deps: ServiceControlDeps,
): Promise<string> {
  const commands = getServiceCommands(serviceName, deps.platform, deps.homeDir, deps.getUid());
  if (!commands) return `unsupported on ${deps.platform}`;
  const result = await deps.runCommand(commands.statusCmd[0], commands.statusCmd[1]);
  return summarizeServiceStatus(result, deps.platform);
}
