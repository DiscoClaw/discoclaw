import { execFile } from 'node:child_process';
import os from 'node:os';
import type { LoggerLike } from '../logging/logger-like.js';
import { writeShutdownContext } from './shutdown-context.js';

export type RestartCommand = {
  action: 'restart' | 'status' | 'logs' | 'help';
};

export type RestartOpts = {
  log?: LoggerLike;
  dataDir?: string;
  userId?: string;
  activeForge?: string;
};

export function parseRestartCommand(content: string): RestartCommand | null {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '!restart') return { action: 'restart' };
  if (normalized === '!restart status') return { action: 'status' };
  if (normalized === '!restart logs') return { action: 'logs' };
  if (normalized === '!restart help') return { action: 'help' };
  return null;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const exitCode = err ? (err as any).code ?? null : 0;
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: typeof exitCode === 'number' ? exitCode : null,
      });
    });
  });
}

type PlatformCmds = {
  statusCmd: [string, string[]];
  logsCmd: [string, string[]];
  checkActiveCmd: [string, string[]];
  isActive: (result: { exitCode: number | null; stdout: string }) => boolean;
  restartCmd: (wasActive: boolean) => [string, string[]];
};

function getPlatformCommands(): PlatformCmds | null {
  if (process.platform === 'linux') {
    return {
      statusCmd: ['systemctl', ['--user', 'status', 'discoclaw']],
      logsCmd: ['journalctl', ['--user', '-u', 'discoclaw', '--no-pager', '-n', '30']],
      checkActiveCmd: ['systemctl', ['--user', 'status', 'discoclaw']],
      isActive: (result) => result.stdout.includes('active (running)'),
      restartCmd: () => ['systemctl', ['--user', 'restart', 'discoclaw']],
    };
  }
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    const plistPath = `${os.homedir()}/Library/LaunchAgents/com.discoclaw.agent.plist`;
    const domain = `gui/${uid}`;
    const label = 'com.discoclaw.agent';
    return {
      statusCmd: ['launchctl', ['list', label]],
      logsCmd: ['log', ['show', '--predicate', 'process == "node"', '--last', '5m', '--style', 'compact']],
      checkActiveCmd: ['launchctl', ['list', label]],
      isActive: (result) => result.exitCode === 0,
      restartCmd: (wasActive) =>
        wasActive
          ? ['launchctl', ['kickstart', '-k', `${domain}/${label}`]]
          : ['launchctl', ['bootstrap', domain, plistPath]],
    };
  }
  return null;
}

/**
 * Returns [cmd, args] for restarting the discoclaw service on the current
 * platform, assuming the service is already running. Falls back to systemctl
 * on unsupported platforms.
 */
export function getRestartCmdArgs(): [string, string[]] {
  const pc = getPlatformCommands();
  if (pc) return pc.restartCmd(true);
  return ['systemctl', ['--user', 'restart', 'discoclaw']];
}

export type RestartResult = {
  /** The message to send back to Discord. */
  reply: string;
  /**
   * If set, the caller should send the reply first, then call this
   * function to perform a deferred action (e.g., restart the service).
   * The process will likely die before this returns.
   */
  deferred?: () => void;
};

export async function handleRestartCommand(cmd: RestartCommand, opts?: RestartOpts | LoggerLike): Promise<RestartResult> {
  // Support both legacy (log) and new (opts bag) signatures.
  const resolved: RestartOpts = opts && typeof opts === 'object' && 'info' in opts
    ? { log: opts as LoggerLike }
    : (opts as RestartOpts | undefined) ?? {};
  const { log, dataDir, userId, activeForge } = resolved;

  try {
    if (cmd.action === 'help') {
      return {
        reply: [
          '**!restart commands:**',
          '- `!restart` — restart the discoclaw service',
          '- `!restart status` — show service status',
          '- `!restart logs` — show recent logs (last 30 lines)',
          '- `!restart help` — this message',
        ].join('\n'),
      };
    }

    const pc = getPlatformCommands();
    if (!pc) {
      return {
        reply: `!restart is not supported on this platform (${process.platform}). Only Linux (systemd) and macOS (launchd) are supported.`,
      };
    }

    if (cmd.action === 'status') {
      const result = await run(pc.statusCmd[0], pc.statusCmd[1]);
      const output = (result.stdout || result.stderr).trim();
      log?.info({ exitCode: result.exitCode }, 'restart-command:status');
      return { reply: `\`\`\`\n${output.slice(0, 1800)}\n\`\`\`` };
    }

    if (cmd.action === 'logs') {
      const result = await run(pc.logsCmd[0], pc.logsCmd[1]);
      const output = (result.stdout || result.stderr).trim();
      log?.info({}, 'restart-command:logs');
      return { reply: `\`\`\`\n${output.slice(0, 1800)}\n\`\`\`` };
    }

    // action === 'restart'
    // Check current status for context in the reply.
    const before = await run(pc.checkActiveCmd[0], pc.checkActiveCmd[1]);
    const wasActive = pc.isActive(before);
    log?.info({ wasActive }, 'restart-command:restart');

    // We can't restart inline — the restart kills this process before
    // we can reply. Instead, return a deferred function that the caller
    // invokes *after* sending the reply to Discord.
    return {
      reply: wasActive
        ? 'Restarting discoclaw... back in a moment.'
        : 'Starting discoclaw...',
      deferred: () => {
        // Write shutdown context right before triggering restart so it
        // doesn't linger if the deferred never fires or restart fails.
        if (dataDir) {
          const ctx = {
            reason: 'restart-command' as const,
            message: 'User requested via !restart',
            timestamp: new Date().toISOString(),
            requestedBy: userId,
            activeForge,
          };
          // Synchronous-ish: writeFile + rename, then exec restart.
          writeShutdownContext(dataDir, ctx).catch((err) => {
            log?.warn({ err }, 'restart-command:failed to write shutdown context');
          });
        }
        // Fire and forget — the process will die during this call.
        const [restartBin, restartArgs] = pc.restartCmd(wasActive);
        execFile(restartBin, restartArgs, (err) => {
          // If we somehow survive (e.g., the service unit changed), log it.
          if (err) log?.error({ err }, 'restart-command:restart failed');
        });
      },
    };
  } catch (err) {
    return { reply: `Restart command error: ${String(err)}` };
  }
}
