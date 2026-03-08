import { execFile } from 'node:child_process';
import type { LoggerLike } from '../logging/logger-like.js';
import { getPlatformCommands, run } from '../service-control.js';
import { writeShutdownContext } from './shutdown-context.js';

export type RestartCommand = {
  action: 'restart' | 'status' | 'logs' | 'help';
};

export type RestartOpts = {
  log?: LoggerLike;
  dataDir?: string;
  userId?: string;
  activeForge?: string;
  serviceName?: string;
};

export function parseRestartCommand(content: string): RestartCommand | null {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '!restart') return { action: 'restart' };
  if (normalized === '!restart status') return { action: 'status' };
  if (normalized === '!restart logs') return { action: 'logs' };
  if (normalized === '!restart help') return { action: 'help' };
  return null;
}

/**
 * Returns [cmd, args] for restarting the discoclaw service on the current
 * platform, assuming the service is already running. Falls back to systemctl
 * on unsupported platforms.
 */
export function getRestartCmdArgs(serviceName?: string): [string, string[]] {
  const pc = getPlatformCommands(serviceName);
  if (pc) return pc.restartCmd(true);
  return ['systemctl', ['--user', 'restart', serviceName ?? 'discoclaw']];
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
  const { log, dataDir, userId, activeForge, serviceName = 'discoclaw' } = resolved;

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

    const pc = getPlatformCommands(serviceName);
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
        ? `Restarting ${serviceName}... back in a moment.`
        : `Starting ${serviceName}...`,
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
