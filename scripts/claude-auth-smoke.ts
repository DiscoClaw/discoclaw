#!/usr/bin/env tsx

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const defaultRoot = path.resolve(import.meta.dirname, '..');

export const CLAUDE_AUTH_SMOKE_PROMPT = 'Reply with OK';
export const CLAUDE_AUTH_SMOKE_TIMEOUT_MS = 60_000;

export type ClaudeAuthSmokeStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'missing-cli'
  | 'failed';

export type ClaudeAuthSmokeCommandResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  errorCode?: string;
  shortMessage?: string;
};

export type ClaudeAuthSmokeDeps = {
  log?: (line: string) => void;
  runClaudeFn?: (
    bin: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<ClaudeAuthSmokeCommandResult>;
};

export type RunClaudeAuthSmokeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  deps?: ClaudeAuthSmokeDeps;
};

function previewText(value: string, maxLen = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLen
    ? normalized
    : `${normalized.slice(0, maxLen - 1)}…`;
}

export function looksLikeClaudeAuthFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return [
    'auth',
    'authenticate',
    'authentication',
    'credential',
    'login',
    'log in',
    'logged out',
    'not logged in',
    'not authenticated',
    'sign in',
    'unauthenticated',
  ].some((pattern) => normalized.includes(pattern));
}

function looksLikeMissingBinary(result: ClaudeAuthSmokeCommandResult, claudeBin: string): boolean {
  if (result.errorCode === 'ENOENT') return true;

  const combined = `${result.stderr}\n${result.shortMessage ?? ''}`.toLowerCase();
  return combined.includes('enoent')
    || combined.includes('command not found')
    || combined.includes(`spawn ${claudeBin.toLowerCase()}`);
}

export function classifyClaudeAuthSmokeResult(
  result: ClaudeAuthSmokeCommandResult,
  claudeBin: string,
): ClaudeAuthSmokeStatus {
  if (looksLikeMissingBinary(result, claudeBin)) return 'missing-cli';

  const combinedOutput = `${result.stdout}\n${result.stderr}\n${result.shortMessage ?? ''}`.trim();
  if (result.ok && previewText(result.stdout)) return 'authenticated';
  if (looksLikeClaudeAuthFailure(combinedOutput)) return 'unauthenticated';
  return 'failed';
}

async function defaultRunClaudeFn(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ClaudeAuthSmokeCommandResult> {
  try {
    const result = await execa(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      reject: false,
      timeout: opts.timeoutMs,
    });
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
      failed: result.failed,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const typed = error as {
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      timedOut?: unknown;
    };
    return {
      ok: false,
      exitCode: typeof typed.exitCode === 'number' ? typed.exitCode : 1,
      stdout: typeof typed.stdout === 'string' ? typed.stdout : '',
      stderr: typeof typed.stderr === 'string' ? typed.stderr : '',
      failed: true,
      timedOut: typed.timedOut === true,
      errorCode: typeof typed.code === 'string' ? typed.code : undefined,
      shortMessage: typeof typed.shortMessage === 'string'
        ? typed.shortMessage
        : typeof typed.message === 'string'
          ? typed.message
          : undefined,
    };
  }
}

function usage(claudeBin: string): string[] {
  return [
    'Discoclaw Claude auth smoke',
    '',
    `Runs one minimal Claude CLI prompt via ${claudeBin}.`,
    'Exit 0 means the CLI answered. Exit 1 means the CLI is missing, unauthenticated, or failed for another reason.',
  ];
}

export async function runClaudeAuthSmoke(options: RunClaudeAuthSmokeOptions = {}): Promise<number> {
  const {
    cwd = defaultRoot,
    env = process.env,
    argv = process.argv,
    deps = {},
  } = options;

  const log = deps.log ?? console.log;
  const runClaudeFn = deps.runClaudeFn ?? defaultRunClaudeFn;
  const claudeBin = (env.CLAUDE_BIN ?? '').trim() || 'claude';

  if (argv.includes('--help') || argv.includes('-h')) {
    for (const line of usage(claudeBin)) log(line);
    return 0;
  }

  log('\nDiscoclaw Claude auth smoke\n');
  log(`  ℹ Running ${claudeBin} -p -- ${JSON.stringify(CLAUDE_AUTH_SMOKE_PROMPT)}`);
  log('  ℹ This only checks whether Claude can answer one minimal prompt from this repo.');

  const result = await runClaudeFn(claudeBin, ['-p', '--', CLAUDE_AUTH_SMOKE_PROMPT], {
    cwd,
    env,
    timeoutMs: CLAUDE_AUTH_SMOKE_TIMEOUT_MS,
  });
  const status = classifyClaudeAuthSmokeResult(result, claudeBin);
  const combinedPreview = previewText(`${result.stdout}\n${result.stderr}\n${result.shortMessage ?? ''}`);

  switch (status) {
    case 'authenticated': {
      log('  ✓ Claude CLI answered the minimal prompt.');
      if (combinedPreview) log(`    → Output preview: ${combinedPreview}`);
      return 0;
    }
    case 'unauthenticated': {
      log('  ✗ Claude CLI appears installed but not authenticated.');
      log(`    → Run \`${claudeBin}\` to complete login, then rerun this command.`);
      if (combinedPreview) log(`    → CLI output: ${combinedPreview}`);
      return 1;
    }
    case 'missing-cli': {
      log(`  ✗ Claude CLI not found (looked for "${claudeBin}").`);
      log(`    → Install Claude Code or set CLAUDE_BIN to the correct binary before rerunning this command.`);
      if (combinedPreview) log(`    → Launch error: ${combinedPreview}`);
      return 1;
    }
    default: {
      log('  ✗ Claude CLI smoke failed for a non-auth reason.');
      if (result.timedOut) log(`    → Timed out after ${CLAUDE_AUTH_SMOKE_TIMEOUT_MS} ms.`);
      if (combinedPreview) log(`    → CLI output: ${combinedPreview}`);
      return 1;
    }
  }
}

function isMainModule(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return path.resolve(argvPath) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const exitCode = await runClaudeAuthSmoke();
  process.exit(exitCode);
}
