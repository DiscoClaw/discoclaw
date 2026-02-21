import { execFile } from 'node:child_process';
import type { LoggerLike } from '../logging/logger-like.js';
import { writeShutdownContext } from './shutdown-context.js';
import { getActiveOrchestrator, getRunningPlanIds } from './forge-plan-registry.js';

export type UpdateCommand = {
  action: 'check' | 'apply' | 'help';
};

export type UpdateOpts = {
  log?: LoggerLike;
  dataDir?: string;
  userId?: string;
  restartCmd?: string;
  projectCwd?: string;
  onProgress?: (msg: string) => void;
};

export type UpdateResult = {
  reply: string;
  deferred?: () => void;
};

export function parseUpdateCommand(content: string): UpdateCommand | null {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '!update') return { action: 'check' };
  if (normalized === '!update apply') return { action: 'apply' };
  if (normalized === '!update help') return { action: 'help' };
  return null;
}

function run(
  cmd: string,
  args: string[],
  opts: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 60_000,
        cwd: opts.cwd,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        const exitCode = err ? (err as any).code ?? null : 0;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: typeof exitCode === 'number' ? exitCode : null,
        });
      },
    );
  });
}

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export async function handleUpdateCommand(cmd: UpdateCommand, opts: UpdateOpts = {}): Promise<UpdateResult> {
  const { log, dataDir, userId, restartCmd, projectCwd, onProgress } = opts;

  const progress = (msg: string): void => {
    onProgress?.(msg);
    log?.info({}, `update-command: ${msg}`);
  };

  if (cmd.action === 'help') {
    return {
      reply: [
        '**!update commands:**',
        '- `!update` — check for available updates from main',
        '- `!update apply` — pull, install, build, and restart',
        '- `!update help` — this message',
      ].join('\n'),
    };
  }

  if (cmd.action === 'check') {
    progress('Fetching from origin...');
    const fetch = await run('git', ['fetch'], { cwd: projectCwd, env: GIT_ENV, timeout: 60_000 });
    if (fetch.exitCode !== 0) {
      const detail = (fetch.stderr || fetch.stdout).trim().slice(0, 500);
      return { reply: `Failed to fetch from origin: \`${detail}\`` };
    }

    const logResult = await run(
      'git',
      ['log', 'HEAD..origin/main', '--oneline'],
      { cwd: projectCwd, env: GIT_ENV, timeout: 60_000 },
    );
    const commits = logResult.stdout.trim();
    if (!commits) {
      return { reply: 'Already up to date.' };
    }
    return { reply: `Available updates from main:\n\`\`\`\n${commits.slice(0, 1800)}\n\`\`\`` };
  }

  // action === 'apply'

  // 1. Check for active work.
  const activeOrch = getActiveOrchestrator();
  if (activeOrch?.isRunning) {
    return { reply: 'Cannot update: a forge run is in progress. Wait for it to finish or cancel it first.' };
  }
  if (getRunningPlanIds().size > 0) {
    return { reply: 'Cannot update: a plan run is in progress. Wait for it to finish first.' };
  }

  // 2. Check for dirty tree.
  progress('Checking working tree...');
  const statusResult = await run('git', ['status', '--porcelain'], { cwd: projectCwd, env: GIT_ENV, timeout: 60_000 });
  if (statusResult.stdout.trim()) {
    return { reply: 'Cannot update: working tree has uncommitted changes. Stash or commit them first.' };
  }

  // 3. git pull
  progress('Pulling from origin/main...');
  const pull = await run('git', ['pull'], { cwd: projectCwd, env: GIT_ENV, timeout: 60_000 });
  if (pull.exitCode !== 0) {
    const detail = (pull.stderr || pull.stdout).trim().slice(0, 500);
    return { reply: `\`git pull\` failed:\n\`\`\`\n${detail}\n\`\`\`` };
  }

  // 4. pnpm install
  progress('Running pnpm install...');
  const install = await run('pnpm', ['install'], { cwd: projectCwd, timeout: 120_000 });
  if (install.exitCode !== 0) {
    const detail = (install.stderr || install.stdout).trim().slice(0, 500);
    return { reply: `\`pnpm install\` failed:\n\`\`\`\n${detail}\n\`\`\`` };
  }

  // 5. pnpm build
  progress('Running pnpm build...');
  const build = await run('pnpm', ['build'], { cwd: projectCwd, timeout: 120_000 });
  if (build.exitCode !== 0) {
    const detail = (build.stderr || build.stdout).trim().slice(0, 500);
    return { reply: `\`pnpm build\` failed:\n\`\`\`\n${detail}\n\`\`\`` };
  }

  return {
    reply: 'Update complete. Restarting discoclaw... back in a moment.',
    deferred: () => {
      if (dataDir) {
        const ctx = {
          reason: 'restart-command' as const,
          message: 'User requested via !update apply',
          timestamp: new Date().toISOString(),
          requestedBy: userId,
        };
        writeShutdownContext(dataDir, ctx).catch((err) => {
          log?.warn({ err }, 'update-command: failed to write shutdown context');
        });
      }

      if (restartCmd) {
        execFile('/bin/sh', ['-c', restartCmd], (err) => {
          if (err) log?.error({ err }, 'update-command: restart failed');
        });
      } else {
        execFile('systemctl', ['--user', 'restart', 'discoclaw'], (err) => {
          if (err) log?.error({ err }, 'update-command: restart failed');
        });
      }
    },
  };
}
