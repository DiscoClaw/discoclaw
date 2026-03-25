#!/usr/bin/env tsx

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { execa, type ResultPromise } from 'execa';
import { Client, GatewayIntentBits, ChannelType, type ForumChannel, type Guild } from 'discord.js';
import { TaskStore } from '../src/tasks/store.js';
import { createTaskService } from '../src/tasks/service.js';
import { loadTagMap } from '../src/tasks/tag-map.js';
import { resolveTaskDataLoadPath, resolveTaskDataPath } from '../src/tasks/path-defaults.js';
import { runTaskSyncWithStore } from '../src/tasks/task-sync-cli.js';
import { loadRunStats } from '../src/cron/run-stats.js';
import { killProcessTree } from '../src/runtime/cli-shared.js';
import { createAutoCheckpoint } from './auto-checkpoint.js';

const defaultRoot = path.resolve(import.meta.dirname, '..');

const CLOSEOUT_DIR = path.join('docs', 'release-audit');
const DEV_READY_TIMEOUT_MS = 90_000;
const DEV_STOP_GRACE_MS = 5_000;
const DEV_FORCE_KILL_WAIT_MS = 5_000;
const CRON_DISABLE_SETTLE_MS = 2_000;
const TASK_ARCHIVED_FETCH_LIMIT = 100;
const CRON_ARCHIVED_FETCH_LIMIT = 100;
export const DEV_READY_LOG_LINE = 'Discord runtime ready';
const DEV_READY_TIMEOUT_PREFIX = 'Timed out waiting for dev ready boundary';
const DEV_READY_SENTINEL_ENV_KEY = 'DISCOCLAW_STARTUP_READY_FILE';
const CHILD_ENV_PASSTHROUGH_KEYS = [
  'APPDATA',
  'CI',
  'COLORTERM',
  'ComSpec',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PNPM_HOME',
  'SHELL',
  'SSH_AUTH_SOCK',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const SOURCE_CHECKOUT_MARKERS = [
  'package.json',
  'pnpm-lock.yaml',
  path.join('src', 'index.ts'),
  path.join('scripts', 'doctor.ts'),
];
const SOURCE_CHECKOUT_GIT_METADATA = '.git';
const REHEARSAL_STRIPPED_REPO_ENV_KEYS = [
  'BEADS_DIR',
  'COLD_STORAGE_DB_PATH',
  'DISCOCLAW_CANVAS_ARTIFACT_DIR',
  'DISCOCLAW_CANVAS_EXPORT_DIR',
  'DISCOCLAW_CONTENT_DIR',
  'DISCOCLAW_CRON_STATS_DIR',
  'DISCOCLAW_DATA_DIR',
  'DISCOCLAW_DURABLE_DATA_DIR',
  'DISCOCLAW_SHORTTERM_DATA_DIR',
  'DISCOCLAW_SUMMARY_ARCHIVE_DIR',
  'DISCOCLAW_SUMMARY_DATA_DIR',
  'DISCOCLAW_TASKS_PATH',
  'DISCOCLAW_TASKS_TAG_MAP',
  'DISCOCLAW_WEBHOOK_CONFIG',
  'GROUPS_DIR',
  'WORKSPACE_CWD',
] as const;

export type ReleaseRehearsalVerdict = 'pass' | 'blocked' | 'failed';
export type ReleaseRehearsalStepStatus = 'pass' | 'fail' | 'blocked' | 'skipped';
export type ReleaseRehearsalCheckpointStatus = 'pass' | 'fail' | 'skipped';
export type ReleaseRehearsalCheckoutProvenance = 'throwaway-clone' | 'reused-checkout';

export type ReleaseRehearsalStep = {
  id: string;
  label: string;
  status: ReleaseRehearsalStepStatus;
  command?: string;
  summary: string;
  detail?: string;
  outputPreview?: string;
};

export type ReleaseRehearsalCleanupLeftover = {
  kind: 'task' | 'task-thread' | 'cron-thread' | 'cron-record' | 'tmp-root';
  id: string;
  name: string;
  reason: string;
};

export type ReleaseRehearsalCleanupResult = {
  closedTaskIds: string[];
  archivedTaskThreadIds: string[];
  archivedCronThreadIds: string[];
  disabledCronIds: string[];
  leftovers: ReleaseRehearsalCleanupLeftover[];
  notes: string[];
};

export type ReleaseRehearsalSummary = {
  verdict: ReleaseRehearsalVerdict;
  repoRoot: string;
  envPath: string;
  checkoutProvenance?: ReleaseRehearsalCheckoutProvenance;
  slug: string;
  startedAt: string;
  finishedAt?: string;
  closeoutJsonPath: string;
  closeoutMarkdownPath: string;
  refusalReason?: string;
  envOverrides: {
    DISCOCLAW_DATA_DIR: string;
    WORKSPACE_CWD: string;
    GROUPS_DIR: string;
    BEADS_DIR: string;
    DISCOCLAW_TASKS_PREFIX: string;
    CLAUDE_DEBUG_FILE: string;
    DISCOCLAW_STARTUP_READY_FILE: string;
  };
  artifacts: {
    taskTitle: string;
    cronName: string;
  };
  steps: ReleaseRehearsalStep[];
  cleanup: ReleaseRehearsalCleanupResult;
};

export type ReleaseRehearsalRunResult = {
  exitCode: number;
  summary: ReleaseRehearsalSummary;
};

export type ReleaseRehearsalCommandSpec = {
  id: string;
  label: string;
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type ReleaseRehearsalCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ReleaseRehearsalCheckpointPrompt = {
  id: string;
  label: string;
  instructions: string[];
};

type ReleaseRehearsalInterruptError = Error & {
  signal: NodeJS.Signals;
};

export type ReleaseRehearsalDevSession = {
  ready: () => Promise<ReleaseRehearsalCommandResult>;
  stop: () => Promise<ReleaseRehearsalCommandResult>;
  peekOutput?: () => string;
  peekExitCode?: () => number | undefined;
};

export type ReleaseRehearsalDeps = {
  now?: () => Date;
  randomSuffix?: () => string;
  existsSync?: (filePath: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  mkdir?: typeof fsp.mkdir;
  writeFile?: typeof fsp.writeFile;
  log?: (line: string) => void;
  runCommand?: (spec: ReleaseRehearsalCommandSpec) => Promise<ReleaseRehearsalCommandResult>;
  startDev?: (spec: ReleaseRehearsalCommandSpec) => Promise<ReleaseRehearsalDevSession>;
  promptCheckpoint?: (
    prompt: ReleaseRehearsalCheckpointPrompt,
  ) => Promise<ReleaseRehearsalCheckpointStatus>;
  cleanupArtifacts?: (ctx: {
    repoRoot: string;
    slug: string;
    childEnv: NodeJS.ProcessEnv;
    envOverrides: ReleaseRehearsalSummary['envOverrides'];
    artifacts: ReleaseRehearsalSummary['artifacts'];
    log: (line: string) => void;
  }) => Promise<ReleaseRehearsalCleanupResult>;
  resolveCheckoutProvenance?: (
    argv: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<ReleaseRehearsalCheckoutProvenance | undefined>;
  sleep?: (ms: number) => Promise<void>;
};

type PersistedScaffoldState = {
  guildId?: string;
  tasksForumId?: string;
  cronsForumId?: string;
};

function usage(): string[] {
  return [
    'Discoclaw release rehearsal',
    '',
    'Runs the repo-owned Claude 1.0 release rehearsal for a source checkout with a repo-local .env.',
    'This harness blocks on missing repo-local config, unsupported PRIMARY_RUNTIME, command failures,',
    'manual checkpoint failures, or any rehearsal task/cron artifact left active after teardown.',
    'Optionally record checkout provenance with --checkout-provenance=throwaway-clone|reused-checkout,',
    'RELEASE_REHEARSAL_CHECKOUT_PROVENANCE, or the interactive prompt.',
    '',
    'Flags:',
    '  --auto                      Replace TTY checkpoints with programmatic Discord API verification.',
    '  --auto-channel=<id>         Text-channel ID for auto-checkpoint probe messages (required with --auto).',
    '  --auto-poll-interval=<ms>   Milliseconds between polls for a bot reply (default: 2000).',
    '  --auto-poll-timeout=<ms>    Maximum milliseconds to wait for a bot reply (default: 120000).',
  ];
}

function previewText(value: string, maxLen = 200): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLen
    ? normalized
    : `${normalized.slice(0, maxLen - 1)}…`;
}

function normalizeCheckpointStatus(
  status: ReleaseRehearsalCheckpointStatus | 'skip' | string,
): ReleaseRehearsalCheckpointStatus {
  if (status === 'pass' || status === 'fail' || status === 'skipped') {
    return status;
  }
  return status === 'skip' ? 'skipped' : 'skipped';
}

function commandString(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

export function hasReachedDevReadyBoundary(output: string): boolean {
  return output.includes(DEV_READY_LOG_LINE);
}

function isDevReadyTimeout(result: ReleaseRehearsalCommandResult): boolean {
  return result.stderr.includes(DEV_READY_TIMEOUT_PREFIX);
}

function getStepStatus(
  steps: ReleaseRehearsalStep[],
  stepId: string,
): ReleaseRehearsalStepStatus | undefined {
  return steps.find((step) => step.id === stepId)?.status;
}

function dateStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').slice(0, 15);
}

function formatIso(now: Date): string {
  return now.toISOString();
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function buildReleaseRehearsalSlug(
  now: Date,
  suffix = defaultRandomSuffix(),
): string {
  const stamp = dateStamp(now);
  return `rr-${stamp.slice(0, 8)}-${stamp.slice(9, 15)}-${suffix.toLowerCase()}`;
}

export function looksLikeSourceCheckout(
  repoRoot: string,
  existsSync: (filePath: string) => boolean = fs.existsSync,
): boolean {
  return existsSync(path.join(repoRoot, SOURCE_CHECKOUT_GIT_METADATA))
    && SOURCE_CHECKOUT_MARKERS.every((marker) => existsSync(path.join(repoRoot, marker)));
}

function buildEnvOverrides(repoRoot: string, slug: string) {
  const rehearsalRoot = path.join(os.tmpdir(), 'discoclaw-release-rehearsal', slug);
  const dataDir = path.join(rehearsalRoot, 'data');
  const workspaceDir = path.join(rehearsalRoot, 'workspace');
  const groupsDir = path.join(workspaceDir, 'groups');
  const beadsDir = path.join(workspaceDir, '.beads');
  const taskPrefix = `rr${slug.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-10)}`;
  const claudeDebugFile = path.join(rehearsalRoot, 'claude-debug.log');
  const startupReadyFile = path.join(rehearsalRoot, 'startup-ready.json');

  return {
    repoRoot,
    rehearsalRoot,
    envOverrides: {
      DISCOCLAW_DATA_DIR: dataDir,
      WORKSPACE_CWD: workspaceDir,
      GROUPS_DIR: groupsDir,
      BEADS_DIR: beadsDir,
      DISCOCLAW_TASKS_PREFIX: taskPrefix,
      CLAUDE_DEBUG_FILE: claudeDebugFile,
      DISCOCLAW_STARTUP_READY_FILE: startupReadyFile,
    },
  };
}

function buildArtifacts(slug: string) {
  return {
    taskTitle: `Release rehearsal ${slug} task`,
    cronName: `Release rehearsal ${slug} cron`,
  };
}

function makeStep(
  id: string,
  label: string,
  status: ReleaseRehearsalStepStatus,
  summary: string,
  extras: Partial<Omit<ReleaseRehearsalStep, 'id' | 'label' | 'status' | 'summary'>> = {},
): ReleaseRehearsalStep {
  return {
    id,
    label,
    status,
    summary,
    ...extras,
  };
}

function emptyCleanupResult(): ReleaseRehearsalCleanupResult {
  return {
    closedTaskIds: [],
    archivedTaskThreadIds: [],
    archivedCronThreadIds: [],
    disabledCronIds: [],
    leftovers: [],
    notes: [],
  };
}

class ReleaseRehearsalAbort extends Error {
  verdict: ReleaseRehearsalVerdict;

  constructor(verdict: ReleaseRehearsalVerdict) {
    super(`Release rehearsal aborted with verdict ${verdict}.`);
    this.name = 'ReleaseRehearsalAbort';
    this.verdict = verdict;
  }
}

function createInterruptError(signal: NodeJS.Signals): ReleaseRehearsalInterruptError {
  const error = new Error(`Release rehearsal interrupted by ${signal}.`) as ReleaseRehearsalInterruptError;
  error.name = 'ReleaseRehearsalInterruptError';
  error.signal = signal;
  return error;
}

function isInterruptError(error: unknown): error is ReleaseRehearsalInterruptError {
  return error instanceof Error && error.name === 'ReleaseRehearsalInterruptError';
}

async function defaultRunCommand(spec: ReleaseRehearsalCommandSpec): Promise<ReleaseRehearsalCommandResult> {
  const [command, ...args] = spec.command;
  const result = await execa(command, args, {
    cwd: spec.cwd,
    env: spec.env,
    reject: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function captureDevOutput(child: ResultPromise, buffer: string[]): void {
  child.all?.on('data', (chunk: Buffer | string) => {
    buffer.push(String(chunk));
  });
}

async function waitForChildExit(child: ResultPromise, timeoutMs: number): Promise<boolean> {
  const exited = await Promise.race([
    child.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  return exited;
}

function signalDevProcessTree(child: ResultPromise, signal: NodeJS.Signals): void {
  if (typeof child.pid === 'number' && child.pid > 0) {
    killProcessTree(child.pid, signal);
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort: the root may already be gone after process-tree signaling.
  }
}

async function defaultStartDev(spec: ReleaseRehearsalCommandSpec): Promise<ReleaseRehearsalDevSession> {
  const [command, ...args] = spec.command;
  const readySentinelPath = spec.env[DEV_READY_SENTINEL_ENV_KEY];
  const readyWaiterTracePath =
    typeof readySentinelPath === 'string' && readySentinelPath.length > 0
      ? `${readySentinelPath}.waiter.log`
      : undefined;
  const traceReadyWaiter = (message: string) => {
    if (!readyWaiterTracePath) return;
    try {
      fs.appendFileSync(readyWaiterTracePath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Best-effort trace only.
    }
  };
  if (typeof readySentinelPath === 'string' && readySentinelPath.length > 0) {
    try {
      fs.rmSync(readySentinelPath, { force: true });
      fs.rmSync(readyWaiterTracePath!, { force: true });
    } catch {
      // Best-effort: a stale sentinel should not block the new start attempt.
    }
  }
  const child = execa(command, args, {
    cwd: spec.cwd,
    env: spec.env,
    reject: false,
    all: true,
  });
  const outputChunks: string[] = [];
  captureDevOutput(child, outputChunks);

  const ready = async (): Promise<ReleaseRehearsalCommandResult> => {
    const startedAt = Date.now();
    traceReadyWaiter(`wait-start pid=${child.pid ?? 'unknown'} command=${commandString(spec.command)}`);
    while (Date.now() - startedAt < DEV_READY_TIMEOUT_MS) {
      if (child.exitCode !== undefined) {
        traceReadyWaiter(`child-exit exitCode=${child.exitCode ?? 'unknown'}`);
        return {
          exitCode: child.exitCode ?? 1,
          stdout: outputChunks.join(''),
          stderr: '',
        };
      }

      const joined = outputChunks.join('');
      if (hasReachedDevReadyBoundary(joined)) {
        traceReadyWaiter(`ready-log-detected line=${DEV_READY_LOG_LINE}`);
        return {
          exitCode: 0,
          stdout: joined,
          stderr: '',
        };
      }
      if (typeof readySentinelPath === 'string' && readySentinelPath.length > 0 && fs.existsSync(readySentinelPath)) {
        traceReadyWaiter(`ready-sentinel-detected path=${readySentinelPath}`);
        return {
          exitCode: 0,
          stdout: `${joined}\n[release-rehearsal] Ready sentinel observed at ${readySentinelPath}\n`,
          stderr: '',
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    traceReadyWaiter(`wait-timeout afterMs=${Date.now() - startedAt}`);
    return {
      exitCode: 1,
      stdout: outputChunks.join(''),
      stderr: `${DEV_READY_TIMEOUT_PREFIX} (${DEV_READY_LOG_LINE}).`,
    };
  };

  const stop = async (): Promise<ReleaseRehearsalCommandResult> => {
    if (child.exitCode === undefined) {
      signalDevProcessTree(child, 'SIGINT');
      const exitedAfterSigint = await waitForChildExit(child, DEV_STOP_GRACE_MS);
      if (!exitedAfterSigint && child.exitCode === undefined) {
        signalDevProcessTree(child, 'SIGKILL');
        const exitedAfterSigkill = await waitForChildExit(child, DEV_FORCE_KILL_WAIT_MS);
        if (!exitedAfterSigkill && child.exitCode === undefined) {
          return {
            exitCode: 1,
            stdout: outputChunks.join(''),
            stderr: 'Timed out waiting for pnpm dev to exit after SIGINT/SIGKILL.',
          };
        }
      }
    }

    return {
      exitCode: child.exitCode ?? 0,
      stdout: outputChunks.join(''),
      stderr: '',
    };
  };

  return {
    ready,
    stop,
    peekOutput: () => outputChunks.join(''),
    peekExitCode: () => child.exitCode ?? undefined,
  };
}

async function defaultPromptCheckpoint(
  prompt: ReleaseRehearsalCheckpointPrompt,
): Promise<ReleaseRehearsalCheckpointStatus> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'skipped';
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(`\n${prompt.label}\n`);
    for (const line of prompt.instructions) {
      process.stdout.write(`- ${line}\n`);
    }

    while (true) {
      const answer = (await rl.question('Result? [p]ass / [f]ail / [s]kip: ')).trim().toLowerCase();
      if (answer === 'p' || answer === 'pass') return 'pass';
      if (answer === 'f' || answer === 'fail') return 'fail';
      if (answer === 's' || answer === 'skip') return 'skipped';
    }
  } finally {
    rl.close();
  }
}

function readRepoEnv(
  envPath: string,
  readFileSync: typeof fs.readFileSync,
): NodeJS.ProcessEnv {
  return dotenv.parse(readFileSync(envPath, 'utf8'));
}

function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  repoEnv: NodeJS.ProcessEnv,
  rehearsalEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of CHILD_ENV_PASSTHROUGH_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  for (const [key, value] of Object.entries(parentEnv)) {
    if ((key.startsWith('LC_') || key.startsWith('XDG_')) && value !== undefined) {
      childEnv[key] = value;
    }
  }

  const sanitizedRepoEnv: NodeJS.ProcessEnv = { ...repoEnv };
  for (const key of REHEARSAL_STRIPPED_REPO_ENV_KEYS) {
    delete sanitizedRepoEnv[key];
  }

  return {
    ...childEnv,
    ...sanitizedRepoEnv,
    ...rehearsalEnv,
  };
}

function parseCheckoutProvenance(
  rawValue: string | undefined,
): ReleaseRehearsalCheckoutProvenance | null {
  const normalized = String(rawValue ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'throwaway-clone' || normalized === 'throwaway clone' || normalized === 'throwaway_clone') {
    return 'throwaway-clone';
  }
  if (normalized === 'reused-checkout' || normalized === 'reused checkout' || normalized === 'reused_checkout') {
    return 'reused-checkout';
  }
  return null;
}

function readCheckoutProvenanceFromArgv(
  argv: string[],
): ReleaseRehearsalCheckoutProvenance | null {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) continue;
    if (current.startsWith('--checkout-provenance=')) {
      return parseCheckoutProvenance(current.slice('--checkout-provenance='.length));
    }
    if (current === '--checkout-provenance') {
      return parseCheckoutProvenance(argv[index + 1]);
    }
  }
  return null;
}

function readArgvFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function readArgvValue(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) continue;
    if (current.startsWith(`${name}=`)) {
      return current.slice(name.length + 1);
    }
    if (current === name && index + 1 < argv.length) {
      return argv[index + 1];
    }
  }
  return undefined;
}

function readArgvInt(argv: string[], name: string): number | undefined {
  const raw = readArgvValue(argv, name);
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatCheckoutProvenance(
  provenance: ReleaseRehearsalCheckoutProvenance,
): string {
  return provenance === 'throwaway-clone' ? 'throwaway clone' : 'reused checkout';
}

async function defaultResolveCheckoutProvenance(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<ReleaseRehearsalCheckoutProvenance | undefined> {
  const fromArgv = readCheckoutProvenanceFromArgv(argv);
  if (fromArgv) return fromArgv;

  const fromEnv = parseCheckoutProvenance(env.RELEASE_REHEARSAL_CHECKOUT_PROVENANCE);
  if (fromEnv) return fromEnv;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (
        await rl.question('Checkout provenance? [t]hrowaway clone / [r]eused checkout: ')
      ).trim().toLowerCase();
      if (answer === 't' || answer === 'throwaway' || answer === 'throwaway clone' || answer === 'throwaway-clone') {
        return 'throwaway-clone';
      }
      if (answer === 'r' || answer === 'reused' || answer === 'reused checkout' || answer === 'reused-checkout') {
        return 'reused-checkout';
      }
    }
  } finally {
    rl.close();
  }
}

function renderCloseoutMarkdown(summary: ReleaseRehearsalSummary): string {
  const lines: string[] = [];
  lines.push('# Claude Release Rehearsal Closeout');
  lines.push('');
  lines.push(`- Verdict: \`${summary.verdict}\``);
  lines.push(`- Repo root: \`${summary.repoRoot}\``);
  lines.push(`- Repo-local env: \`${summary.envPath}\``);
  if (summary.checkoutProvenance) {
    lines.push(`- Checkout provenance: \`${formatCheckoutProvenance(summary.checkoutProvenance)}\``);
  }
  lines.push(`- Rehearsal slug: \`${summary.slug}\``);
  lines.push(`- Started: \`${summary.startedAt}\``);
  if (summary.finishedAt) lines.push(`- Finished: \`${summary.finishedAt}\``);
  lines.push('');
  lines.push('## Isolation');
  lines.push('');
  lines.push(`- \`DISCOCLAW_DATA_DIR=${summary.envOverrides.DISCOCLAW_DATA_DIR}\``);
  lines.push(`- \`WORKSPACE_CWD=${summary.envOverrides.WORKSPACE_CWD}\``);
  lines.push(`- \`GROUPS_DIR=${summary.envOverrides.GROUPS_DIR}\``);
  lines.push(`- \`BEADS_DIR=${summary.envOverrides.BEADS_DIR}\``);
  lines.push(`- \`DISCOCLAW_TASKS_PREFIX=${summary.envOverrides.DISCOCLAW_TASKS_PREFIX}\``);
  lines.push(`- \`CLAUDE_DEBUG_FILE=${summary.envOverrides.CLAUDE_DEBUG_FILE}\``);
  lines.push(`- \`DISCOCLAW_STARTUP_READY_FILE=${summary.envOverrides.DISCOCLAW_STARTUP_READY_FILE}\``);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- Task title: \`${summary.artifacts.taskTitle}\``);
  lines.push(`- Cron name: \`${summary.artifacts.cronName}\``);
  lines.push('');

  if (summary.refusalReason) {
    lines.push('## Refusal');
    lines.push('');
    lines.push(`- ${summary.refusalReason}`);
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of summary.steps) {
    lines.push(`- ${step.label}: \`${step.status}\` — ${step.summary}`);
    if (step.command) lines.push(`  Command: \`${step.command}\``);
    if (step.outputPreview) lines.push(`  Output: \`${step.outputPreview}\``);
    if (step.detail) lines.push(`  Detail: ${step.detail}`);
  }
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  lines.push(`- Closed tasks: ${summary.cleanup.closedTaskIds.length}`);
  lines.push(`- Archived task threads: ${summary.cleanup.archivedTaskThreadIds.length}`);
  lines.push(`- Archived cron threads: ${summary.cleanup.archivedCronThreadIds.length}`);
  lines.push(`- Disabled cron records: ${summary.cleanup.disabledCronIds.length}`);
  if (summary.cleanup.notes.length > 0) {
    for (const note of summary.cleanup.notes) {
      lines.push(`- Note: ${note}`);
    }
  }
  if (summary.cleanup.leftovers.length > 0) {
    lines.push('');
    lines.push('## Blockers');
    lines.push('');
    for (const leftover of summary.cleanup.leftovers) {
      lines.push(`- ${leftover.kind} \`${leftover.name}\` (${leftover.id}) — ${leftover.reason}`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeCloseout(
  summary: ReleaseRehearsalSummary,
  deps: Required<Pick<ReleaseRehearsalDeps, 'mkdir' | 'writeFile'>>,
): Promise<void> {
  await deps.mkdir(path.dirname(summary.closeoutJsonPath), { recursive: true });
  await deps.writeFile(summary.closeoutJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await deps.writeFile(summary.closeoutMarkdownPath, renderCloseoutMarkdown(summary), 'utf8');
}

export async function cleanupLocalRehearsalRoot(
  rehearsalRoot: string,
  slug: string,
  deps: {
    rm?: typeof fsp.rm;
    existsSync?: (filePath: string) => boolean;
  } = {},
): Promise<{ note?: string; leftover?: ReleaseRehearsalCleanupLeftover }> {
  const rm = deps.rm ?? fsp.rm;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const expectedSuffix = path.join('discoclaw-release-rehearsal', slug);
  const normalizedRoot = path.normalize(rehearsalRoot);
  const normalizedSuffix = path.normalize(expectedSuffix);

  if (!normalizedRoot.endsWith(normalizedSuffix)) {
    return {
      leftover: {
        kind: 'tmp-root',
        id: rehearsalRoot,
        name: slug,
        reason: `Refusing to remove unexpected rehearsal root path ${rehearsalRoot}.`,
      },
    };
  }

  try {
    await rm(rehearsalRoot, { recursive: true, force: true });
  } catch (error) {
    return {
      leftover: {
        kind: 'tmp-root',
        id: rehearsalRoot,
        name: slug,
        reason: `Failed to remove local rehearsal root: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (existsSync(rehearsalRoot)) {
    return {
      leftover: {
        kind: 'tmp-root',
        id: rehearsalRoot,
        name: slug,
        reason: 'Local rehearsal temp root still exists after teardown.',
      },
    };
  }

  return {
    note: `Removed local rehearsal root ${rehearsalRoot}.`,
  };
}

async function readPersistedScaffoldState(dataDir: string): Promise<PersistedScaffoldState> {
  const scaffoldPath = path.join(dataDir, 'system-scaffold.json');
  try {
    const raw = await fsp.readFile(scaffoldPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedScaffoldState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function connectDiscordForCleanup(
  env: NodeJS.ProcessEnv,
): Promise<{ client: Client; guild: Guild; scaffold: PersistedScaffoldState }> {
  const token = String(env.DISCORD_TOKEN ?? '').trim();
  if (!token) throw new Error('DISCORD_TOKEN is required for cleanup');
  const preferredGuildId = String(env.DISCORD_GUILD_ID ?? '').trim();
  if (!preferredGuildId) {
    throw new Error('DISCORD_GUILD_ID is required for deterministic cleanup');
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise<void>((resolve) => {
    if (client.isReady()) resolve();
    else client.once('ready', () => resolve());
  });

  const scaffold = await readPersistedScaffoldState(String(env.DISCOCLAW_DATA_DIR ?? ''));
  const guild = await client.guilds.fetch(preferredGuildId);

  if (!guild) {
    client.destroy();
    throw new Error('Could not resolve a Discord guild for cleanup');
  }

  return { client, guild, scaffold };
}

async function resolveForum(
  guild: Guild,
  nameOrId: string,
): Promise<ForumChannel | null> {
  const wanted = nameOrId.trim();
  if (!wanted) return null;

  const byId = guild.channels.cache.get(wanted);
  if (byId?.type === ChannelType.GuildForum) return byId as ForumChannel;

  try {
    const fetched = await guild.channels.fetch(wanted);
    if (fetched?.type === ChannelType.GuildForum) return fetched as ForumChannel;
  } catch {
    // Fall through to name lookup.
  }

  const lower = wanted.toLowerCase();
  const byName = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildForum && channel.name.toLowerCase() === lower,
  );
  return (byName as ForumChannel | undefined) ?? null;
}

async function listForumThreadsBySlug(
  forum: ForumChannel,
  slug: string,
  archivedLimit: number,
): Promise<Array<{ id: string; name: string; archived: boolean }>> {
  const active = await forum.threads.fetchActive();
  const archived = await forum.threads.fetchArchived({ limit: archivedLimit, fetchAll: true });
  return [...active.threads.values(), ...archived.threads.values()]
    .filter((thread) => thread.name.includes(slug))
    .map((thread) => ({
      id: thread.id,
      name: thread.name,
      archived: thread.archived === true,
    }));
}

async function defaultCleanupArtifacts(ctx: {
  repoRoot: string;
  slug: string;
  childEnv: NodeJS.ProcessEnv;
  envOverrides: ReleaseRehearsalSummary['envOverrides'];
  artifacts: ReleaseRehearsalSummary['artifacts'];
  log: (line: string) => void;
}): Promise<ReleaseRehearsalCleanupResult> {
  const cleanup: ReleaseRehearsalCleanupResult = {
    closedTaskIds: [],
    archivedTaskThreadIds: [],
    archivedCronThreadIds: [],
    disabledCronIds: [],
    leftovers: [],
    notes: [],
  };

  const dataDir = String(ctx.childEnv.DISCOCLAW_DATA_DIR ?? '').trim();
  if (!dataDir) {
    cleanup.leftovers.push({
      kind: 'task',
      id: 'missing-data-dir',
      name: ctx.slug,
      reason: 'Cleanup could not resolve DISCOCLAW_DATA_DIR.',
    });
    return cleanup;
  }

  let client: Client | null = null;

  try {
    const connected = await connectDiscordForCleanup(ctx.childEnv);
    client = connected.client;
    const { guild, scaffold } = connected;

    const tasksPath = await resolveTaskDataLoadPath(dataDir, 'tasks.jsonl')
      ?? resolveTaskDataPath(dataDir, 'tasks.jsonl');
    const taskStore = new TaskStore({
      prefix: ctx.envOverrides.DISCOCLAW_TASKS_PREFIX,
      ...(tasksPath ? { persistPath: tasksPath } : {}),
    });
    if (tasksPath) await taskStore.load();

    const taskService = createTaskService(taskStore);
    const rehearsalTasks = taskStore
      .list({ status: 'all' })
      .filter((task) => task.title.includes(ctx.slug));

    for (const task of rehearsalTasks) {
      if (task.status !== 'closed') {
        taskService.close(task.id, `Release rehearsal teardown (${ctx.slug})`);
        cleanup.closedTaskIds.push(task.id);
      }
    }
    await taskStore.flush();

    const taskForumRef = String(ctx.childEnv.DISCOCLAW_TASKS_FORUM ?? scaffold.tasksForumId ?? '').trim();
    if (taskForumRef) {
      const taskForum = await resolveForum(guild, taskForumRef);
      if (!taskForum) {
        cleanup.leftovers.push({
          kind: 'task-thread',
          id: taskForumRef,
          name: ctx.artifacts.taskTitle,
          reason: 'Task forum could not be resolved during teardown.',
        });
      } else {
        const tagMapPath = String(
          resolveTaskDataPath(dataDir, 'tag-map.json')
          ?? path.join(dataDir, 'tasks', 'tag-map.json'),
        ).trim();
        const tagMap = tagMapPath ? await loadTagMap(tagMapPath) : {};
        await runTaskSyncWithStore({
          client,
          guild,
          forumId: taskForum.id,
          tagMap,
          store: taskStore,
          archivedDedupeLimit: TASK_ARCHIVED_FETCH_LIMIT,
          mentionUserId: String(ctx.childEnv.DISCOCLAW_TASKS_MENTION_USER ?? '').trim() || undefined,
        });

        const taskThreads = await listForumThreadsBySlug(taskForum, ctx.slug, TASK_ARCHIVED_FETCH_LIMIT);
        cleanup.archivedTaskThreadIds.push(
          ...taskThreads.filter((thread) => thread.archived).map((thread) => thread.id),
        );
        for (const thread of taskThreads.filter((candidate) => !candidate.archived)) {
          cleanup.leftovers.push({
            kind: 'task-thread',
            id: thread.id,
            name: thread.name,
            reason: 'Task thread remained active after closing rehearsal tasks and syncing.',
          });
        }
      }
    } else if (rehearsalTasks.length > 0) {
      cleanup.leftovers.push({
        kind: 'task-thread',
        id: 'missing-task-forum',
        name: ctx.artifacts.taskTitle,
        reason: 'Cleanup found rehearsal tasks but no task forum was configured or scaffolded.',
      });
    }

    for (const task of taskStore.list({ status: 'all' }).filter((candidate) => candidate.title.includes(ctx.slug))) {
      if (task.status !== 'closed') {
        cleanup.leftovers.push({
          kind: 'task',
          id: task.id,
          name: task.title,
          reason: 'Task remained non-closed after teardown.',
        });
      }
    }

    const cronForumRef = String(ctx.childEnv.DISCOCLAW_CRON_FORUM ?? scaffold.cronsForumId ?? '').trim();
    const cronStatsPath = path.join(dataDir, 'cron', 'cron-run-stats.json');
    if (cronForumRef) {
      const cronForum = await resolveForum(guild, cronForumRef);
      if (!cronForum) {
        cleanup.leftovers.push({
          kind: 'cron-thread',
          id: cronForumRef,
          name: ctx.artifacts.cronName,
          reason: 'Cron forum could not be resolved during teardown.',
        });
      } else {
        const beforeArchive = await listForumThreadsBySlug(cronForum, ctx.slug, CRON_ARCHIVED_FETCH_LIMIT);
        for (const thread of beforeArchive.filter((candidate) => !candidate.archived)) {
          const fullThread = await client.channels.fetch(thread.id).catch(() => null);
          if (fullThread?.isThread?.() && fullThread.archived !== true) {
            await fullThread.setArchived(true);
            cleanup.archivedCronThreadIds.push(thread.id);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, CRON_DISABLE_SETTLE_MS));

        const afterArchive = await listForumThreadsBySlug(cronForum, ctx.slug, CRON_ARCHIVED_FETCH_LIMIT);
        for (const thread of afterArchive.filter((candidate) => !candidate.archived)) {
          cleanup.leftovers.push({
            kind: 'cron-thread',
            id: thread.id,
            name: thread.name,
            reason: 'Cron thread remained active after teardown archive.',
          });
        }

        try {
          const statsStore = await loadRunStats(cronStatsPath);
          for (const thread of afterArchive) {
            const record = statsStore.getRecordByThreadId(thread.id);
            if (!record) continue;

            try {
              if (!record.disabled) {
                await statsStore.upsertRecord(record.cronId, thread.id, { disabled: true });
              }
            } catch (error) {
              cleanup.leftovers.push({
                kind: 'cron-record',
                id: record.cronId,
                name: thread.name,
                reason: `Failed to persist disabled=true on the canonical cron record during teardown: ${error instanceof Error ? error.message : String(error)}`,
              });
              continue;
            }

            const persistedRecord = statsStore.getRecord(record.cronId);
            if (persistedRecord?.disabled) {
              cleanup.disabledCronIds.push(persistedRecord.cronId);
            } else {
              cleanup.leftovers.push({
                kind: 'cron-record',
                id: record.cronId,
                name: thread.name,
                reason: 'Cron thread was archived but the canonical cron record is not disabled.',
              });
            }
          }
        } catch (error) {
          cleanup.leftovers.push({
            kind: 'cron-record',
            id: cronStatsPath,
            name: ctx.artifacts.cronName,
            reason: `Cron stats could not be read after teardown: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    } else {
      try {
        const statsStore = await loadRunStats(cronStatsPath);
        if (Object.keys(statsStore.getCanonicalDefinitions()).length > 0) {
          cleanup.leftovers.push({
            kind: 'cron-thread',
            id: 'missing-cron-forum',
            name: ctx.artifacts.cronName,
            reason: 'Cleanup found rehearsal cron records but no cron forum was configured or scaffolded.',
          });
        }
      } catch (error) {
        cleanup.leftovers.push({
          kind: 'cron-record',
          id: cronStatsPath,
          name: ctx.artifacts.cronName,
          reason: `Cron stats could not be read during teardown without a configured cron forum: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (cleanup.closedTaskIds.length === 0 && cleanup.archivedTaskThreadIds.length === 0) {
      cleanup.notes.push('No machine-observed rehearsal tasks or archived task threads were found during teardown.');
    }
    const hasUnresolvedCronArtifacts = cleanup.leftovers.some(
      (leftover) => leftover.kind === 'cron-thread' || leftover.kind === 'cron-record',
    );
    if (
      cleanup.archivedCronThreadIds.length === 0
      && cleanup.disabledCronIds.length === 0
      && !hasUnresolvedCronArtifacts
    ) {
      cleanup.notes.push('No machine-observed rehearsal cron threads or disabled cron records were found during teardown.');
    }

    const rehearsalRoot = path.dirname(dataDir);
    const localCleanup = await cleanupLocalRehearsalRoot(rehearsalRoot, ctx.slug);
    if (localCleanup.note) {
      cleanup.notes.push(localCleanup.note);
    }
    if (localCleanup.leftover) {
      cleanup.leftovers.push(localCleanup.leftover);
    }

    return cleanup;
  } finally {
    client?.destroy();
  }
}

export async function runReleaseRehearsal(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  deps?: ReleaseRehearsalDeps;
} = {}): Promise<ReleaseRehearsalRunResult> {
  const cwd = path.resolve(options.cwd ?? defaultRoot);
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const deps = options.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const mkdir = deps.mkdir ?? fsp.mkdir;
  const writeFile = deps.writeFile ?? fsp.writeFile;
  const log = deps.log ?? console.log;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const startDev = deps.startDev ?? defaultStartDev;
  let promptCheckpoint = deps.promptCheckpoint ?? defaultPromptCheckpoint;
  const cleanupArtifacts = deps.cleanupArtifacts ?? defaultCleanupArtifacts;
  const resolveCheckoutProvenance = deps.resolveCheckoutProvenance ?? defaultResolveCheckoutProvenance;
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix;
  const autoMode = readArgvFlag(argv, '--auto');
  const autoChannelId = readArgvValue(argv, '--auto-channel');
  const autoPollIntervalMs = readArgvInt(argv, '--auto-poll-interval');
  const autoPollTimeoutMs = readArgvInt(argv, '--auto-poll-timeout');

  if (argv.includes('--help') || argv.includes('-h')) {
    for (const line of usage()) log(line);
    return {
      exitCode: 0,
      summary: {
        verdict: 'pass',
        repoRoot: cwd,
        envPath: path.join(cwd, '.env'),
        slug: buildReleaseRehearsalSlug(now(), randomSuffix()),
        startedAt: formatIso(now()),
        closeoutJsonPath: path.join(cwd, CLOSEOUT_DIR, 'release-rehearsal-help.json'),
      closeoutMarkdownPath: path.join(cwd, CLOSEOUT_DIR, 'release-rehearsal-help.md'),
      envOverrides: buildEnvOverrides(cwd, buildReleaseRehearsalSlug(now(), randomSuffix())).envOverrides,
      artifacts: buildArtifacts(buildReleaseRehearsalSlug(now(), randomSuffix())),
      steps: [],
      cleanup: emptyCleanupResult(),
    },
  };
  }

  const startedAt = now();
  const slug = buildReleaseRehearsalSlug(startedAt, randomSuffix());
  const closeoutBase = path.join(cwd, CLOSEOUT_DIR, `claude-release-rehearsal-${slug}`);
  const envPath = path.join(cwd, '.env');
  const envSetup = buildEnvOverrides(cwd, slug);
  const artifacts = buildArtifacts(slug);

  const summary: ReleaseRehearsalSummary = {
    verdict: 'pass',
    repoRoot: cwd,
    envPath,
    slug,
    startedAt: formatIso(startedAt),
    closeoutJsonPath: `${closeoutBase}.json`,
    closeoutMarkdownPath: `${closeoutBase}.md`,
    envOverrides: envSetup.envOverrides,
    artifacts,
    steps: [],
    cleanup: emptyCleanupResult(),
  };

  const finish = async (verdict: ReleaseRehearsalVerdict, exitCode: number) => {
    summary.verdict = verdict;
    summary.finishedAt = formatIso(now());
    await writeCloseout(summary, { mkdir, writeFile });
    return { exitCode, summary };
  };

  if (!looksLikeSourceCheckout(cwd, existsSync)) {
    summary.verdict = 'blocked';
    summary.refusalReason = 'Refusing to run outside a source checkout.';
    summary.steps.push(makeStep(
      'validate-source-checkout',
      'Validate Source Checkout',
      'blocked',
      'Current working tree is missing the git checkout metadata or repo-owned source-checkout markers.',
    ));
    return finish('blocked', 1);
  }

  try {
    summary.checkoutProvenance = await resolveCheckoutProvenance(argv, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.steps.push(makeStep(
      'record-checkout-provenance',
      'Record Checkout Provenance',
      'skipped',
      'Checkout provenance was not recorded; the rehearsal continued because provenance is operator context only.',
      { detail: message },
    ));
  }
  if (!summary.steps.some((step) => step.id === 'record-checkout-provenance')) {
    summary.steps.push(makeStep(
      'record-checkout-provenance',
      'Record Checkout Provenance',
      summary.checkoutProvenance ? 'pass' : 'skipped',
      summary.checkoutProvenance
        ? `Recorded checkout provenance as ${formatCheckoutProvenance(summary.checkoutProvenance)}.`
        : 'Checkout provenance was not supplied; the rehearsal continued because provenance is operator context only.',
    ));
  }

  if (!existsSync(envPath)) {
    summary.verdict = 'blocked';
    summary.refusalReason = 'Refusing to run without a repo-local .env.';
    summary.steps.push(makeStep(
      'validate-repo-env',
      'Validate Repo-Local Env',
      'blocked',
      'Repo-local .env is missing.',
      { detail: `Expected ${envPath}` },
    ));
    return finish('blocked', 1);
  }

  const repoEnv = readRepoEnv(envPath, readFileSync);
  const primaryRuntime = String(repoEnv.PRIMARY_RUNTIME ?? '').trim();
  if (!primaryRuntime) {
    summary.verdict = 'blocked';
    summary.refusalReason = 'Refusing to run because repo-local PRIMARY_RUNTIME is missing.';
    summary.steps.push(makeStep(
      'validate-primary-runtime',
      'Validate PRIMARY_RUNTIME',
      'blocked',
      'Repo-local .env must set PRIMARY_RUNTIME=claude explicitly.',
    ));
    return finish('blocked', 1);
  }
  if (primaryRuntime !== 'claude') {
    summary.verdict = 'blocked';
    summary.refusalReason = `Refusing to run because repo-local PRIMARY_RUNTIME=${primaryRuntime}.`;
    summary.steps.push(makeStep(
      'validate-primary-runtime',
      'Validate PRIMARY_RUNTIME',
      'blocked',
      `Repo-local PRIMARY_RUNTIME must be claude; found ${primaryRuntime}.`,
    ));
    return finish('blocked', 1);
  }
  const guildId = String(repoEnv.DISCORD_GUILD_ID ?? '').trim();
  if (!guildId) {
    summary.verdict = 'blocked';
    summary.refusalReason = 'Refusing to run because repo-local DISCORD_GUILD_ID is missing.';
    summary.steps.push(makeStep(
      'validate-discord-guild-id',
      'Validate DISCORD_GUILD_ID',
      'blocked',
      'Repo-local .env must set DISCORD_GUILD_ID explicitly for the authoritative Discord rehearsal path.',
    ));
    return finish('blocked', 1);
  }

  const childEnv = buildChildEnv(env, repoEnv, summary.envOverrides);

  let autoCheckpointDispose: (() => void) | null = null;
  if (autoMode && !deps.promptCheckpoint) {
    if (!autoChannelId) {
      summary.verdict = 'blocked';
      summary.refusalReason = '--auto requires --auto-channel=<channel-id>.';
      summary.steps.push(makeStep(
        'validate-auto-channel',
        'Validate Auto-Channel',
        'blocked',
        '--auto was set but --auto-channel was not provided.',
      ));
      return finish('blocked', 1);
    }

    const discordToken = String(repoEnv.DISCORD_TOKEN ?? '').trim();
    if (!discordToken) {
      summary.verdict = 'blocked';
      summary.refusalReason = '--auto requires DISCORD_TOKEN in repo-local .env.';
      summary.steps.push(makeStep(
        'validate-auto-token',
        'Validate Auto-Checkpoint Token',
        'blocked',
        '--auto was set but DISCORD_TOKEN is missing from repo-local .env.',
      ));
      return finish('blocked', 1);
    }

    try {
      const autoCtx = await createAutoCheckpoint({
        discordToken,
        channelId: autoChannelId,
        slug,
        artifacts,
        log,
        pollIntervalMs: autoPollIntervalMs,
        pollTimeoutMs: autoPollTimeoutMs,
      });
      promptCheckpoint = autoCtx.promptCheckpoint;
      autoCheckpointDispose = autoCtx.dispose;
      summary.steps.push(makeStep(
        'auto-checkpoint-init',
        'Initialize Auto-Checkpoint',
        'pass',
        `Auto-checkpoint observer connected to channel ${autoChannelId}.`,
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.verdict = 'blocked';
      summary.refusalReason = `Auto-checkpoint initialization failed: ${message}`;
      summary.steps.push(makeStep(
        'auto-checkpoint-init',
        'Initialize Auto-Checkpoint',
        'blocked',
        message,
      ));
      return finish('blocked', 1);
    }
  }

  summary.steps.push(makeStep(
    'validate-inputs',
    'Validate Rehearsal Inputs',
    'pass',
    'Git checkout boundary, repo-local .env, PRIMARY_RUNTIME=claude, and DISCORD_GUILD_ID were all confirmed.',
  ));

  let activeDevSession: ReleaseRehearsalDevSession | null = null;
  let activeDevLabel = '';
  let shouldRunCleanup = false;
  let shouldConfirmCleanBaseline = false;
  let interruptError: ReleaseRehearsalInterruptError | null = null;
  const interruptSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const interruptHandlers = new Map<NodeJS.Signals, () => void>();
  let resolveOnInterrupt: ((error: ReleaseRehearsalInterruptError) => void) | null = null;
  const interruptPromise = new Promise<ReleaseRehearsalInterruptError>((resolve) => {
    resolveOnInterrupt = resolve;
  });

  for (const signal of interruptSignals) {
    const handler = () => {
      if (interruptError) return;
      interruptError = createInterruptError(signal);
      resolveOnInterrupt?.(interruptError);
    };
    interruptHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  const removeInterruptHandlers = () => {
    for (const [signal, handler] of interruptHandlers.entries()) {
      process.removeListener(signal, handler);
    }
    interruptHandlers.clear();
  };

  const stopDevIfRunning = async () => {
    if (!activeDevSession) return;
    log(`Stopping ${activeDevLabel}...`);
    const stopResult = await activeDevSession.stop();
    if (stopResult.stderr) {
      log(stopResult.stderr);
    }
    activeDevSession = null;
    activeDevLabel = '';
  };

  const runCommandStep = async (spec: ReleaseRehearsalCommandSpec): Promise<boolean> => {
    log(`Running ${spec.label}...`);
    const result = await runCommand(spec);
    if (interruptError) throw interruptError;
    const preview = previewText(`${result.stdout}\n${result.stderr}`);
    const ok = result.exitCode === 0;
    summary.steps.push(makeStep(
      spec.id,
      spec.label,
      ok ? 'pass' : 'fail',
      ok ? 'Command completed successfully.' : `Command exited with code ${result.exitCode}.`,
      {
        command: commandString(spec.command),
        outputPreview: preview || undefined,
      },
    ));
    if (!ok) summary.verdict = 'failed';
    return ok;
  };

  const runCheckpoint = async (
    prompt: ReleaseRehearsalCheckpointPrompt,
    options: { required?: boolean } = {},
  ): Promise<boolean> => {
    log(`Waiting on ${prompt.label}...`);
    const status = normalizeCheckpointStatus(await promptCheckpoint(prompt));
    if (interruptError) throw interruptError;
    const stepStatus: ReleaseRehearsalStepStatus =
      status === 'pass'
        ? 'pass'
        : status === 'fail'
          ? 'fail'
          : options.required
            ? 'blocked'
            : 'skipped';
    summary.steps.push(makeStep(
      prompt.id,
      prompt.label,
      stepStatus,
      status === 'pass'
        ? 'Operator confirmed this checkpoint.'
        : status === 'fail'
          ? 'Operator marked this checkpoint failed.'
          : options.required
            ? 'Required manual checkpoint was not completed.'
            : 'Checkpoint was skipped.',
    ));
    if (status === 'fail') summary.verdict = 'failed';
    if (status === 'skipped' && options.required && summary.verdict === 'pass') {
      summary.verdict = 'blocked';
    }
    return status === 'pass';
  };

  const startDevStep = async (id: string, label: string): Promise<boolean> => {
    const spec: ReleaseRehearsalCommandSpec = {
      id,
      label,
      command: ['pnpm', 'dev'],
      cwd,
      env: childEnv,
    };
    log(`Starting ${label}...`);
    activeDevSession = await startDev(spec);
    activeDevLabel = label;
    const readySentinelPath = summary.envOverrides.DISCOCLAW_STARTUP_READY_FILE;
    const canPollLiveSession =
      typeof activeDevSession.peekOutput === 'function' && typeof activeDevSession.peekExitCode === 'function';
    const result = canPollLiveSession
      ? await (async (): Promise<ReleaseRehearsalCommandResult> => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < DEV_READY_TIMEOUT_MS) {
            const exitCode = activeDevSession?.peekExitCode?.();
            const output = activeDevSession?.peekOutput?.() ?? '';
            if (exitCode !== undefined) {
              return {
                exitCode,
                stdout: output,
                stderr: '',
              };
            }
            if (hasReachedDevReadyBoundary(output)) {
              return {
                exitCode: 0,
                stdout: output,
                stderr: '',
              };
            }
            if (typeof readySentinelPath === 'string' && readySentinelPath.length > 0 && fs.existsSync(readySentinelPath)) {
              return {
                exitCode: 0,
                stdout: `${output}\n[release-rehearsal] Ready sentinel observed at ${readySentinelPath}\n`,
                stderr: '',
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }

          return {
            exitCode: 1,
            stdout: activeDevSession?.peekOutput?.() ?? '',
            stderr: `${DEV_READY_TIMEOUT_PREFIX} (${DEV_READY_LOG_LINE}).`,
          };
        })()
      : await activeDevSession.ready();
    if (interruptError) throw interruptError;
    const ok = result.exitCode === 0;
    const timedOutWaitingForReady = isDevReadyTimeout(result);
    summary.steps.push(makeStep(
      id,
      label,
      ok ? 'pass' : timedOutWaitingForReady ? 'blocked' : 'fail',
      ok
        ? 'Dev process reached the rehearsal ready boundary.'
        : timedOutWaitingForReady
          ? 'Dev process did not reach the rehearsal ready boundary before timeout.'
          : 'Dev process failed before reaching the rehearsal ready boundary.',
      {
        command: commandString(spec.command),
        outputPreview: previewText(`${result.stdout}\n${result.stderr}`) || undefined,
      },
    ));
    if (!ok) {
      summary.verdict = timedOutWaitingForReady ? 'blocked' : 'failed';
      await stopDevIfRunning();
    }
    return ok;
  };

  const withInterrupt = async <T>(operation: Promise<T>): Promise<T> => {
    const guardedOperation = operation.then(
      (value) => ({ kind: 'ok' as const, value }),
      (error) => ({ kind: 'error' as const, error }),
    );
    if (interruptError) {
      void guardedOperation;
      throw interruptError;
    }
    const result = await Promise.race([
      guardedOperation,
      interruptPromise.then((error) => ({ kind: 'interrupt' as const, error })),
    ]);
    if (result.kind === 'interrupt') {
      throw result.error;
    }
    if (result.kind === 'error') {
      throw result.error;
    }
    return result.value;
  };

  const runRequiredCheckpoint = async (prompt: ReleaseRehearsalCheckpointPrompt): Promise<void> => {
    const ok = await withInterrupt(runCheckpoint(prompt, { required: true }));
    if (!ok) {
      throw new ReleaseRehearsalAbort(summary.verdict === 'blocked' ? 'blocked' : 'failed');
    }
  };

  const runCleanup = async (): Promise<ReleaseRehearsalCleanupResult> => {
    try {
      return await cleanupArtifacts({
        repoRoot: cwd,
        slug,
        childEnv,
        envOverrides: summary.envOverrides,
        artifacts,
        log,
      });
    } catch (error) {
      const cleanup = emptyCleanupResult();
      const message = error instanceof Error ? error.message : String(error);
      cleanup.leftovers.push({
        kind: 'tmp-root',
        id: envSetup.rehearsalRoot,
        name: slug,
        reason: `Cleanup failed before completion: ${message}`,
      });

      const localCleanup = await cleanupLocalRehearsalRoot(envSetup.rehearsalRoot, slug);
      if (localCleanup.note) cleanup.notes.push(localCleanup.note);
      if (localCleanup.leftover) cleanup.leftovers.push(localCleanup.leftover);

      return cleanup;
    }
  };

  try {
    shouldRunCleanup = true;

    if (!await withInterrupt(runCommandStep({
      id: 'preflight-blank-machine',
      label: 'Run pnpm preflight:blank-machine',
      command: ['pnpm', 'preflight:blank-machine'],
      cwd,
      env: childEnv,
    }))) {
      throw new ReleaseRehearsalAbort('failed');
    }

    if (!await withInterrupt(runCommandStep({
      id: 'claude-auth-smoke',
      label: 'Run pnpm claude:auth-smoke',
      command: ['pnpm', 'claude:auth-smoke'],
      cwd,
      env: childEnv,
    }))) {
      throw new ReleaseRehearsalAbort('failed');
    }

    const discordSmokeCommand = ['pnpm', 'discord:smoke-test', '--', '--guild-id', guildId];
    if (!await withInterrupt(runCommandStep({
      id: 'discord-smoke-test',
      label: 'Run pnpm discord:smoke-test',
      command: discordSmokeCommand,
      cwd,
      env: childEnv,
    }))) {
      throw new ReleaseRehearsalAbort('failed');
    }

    if (!await withInterrupt(runCommandStep({
      id: 'build',
      label: 'Run pnpm build',
      command: ['pnpm', 'build'],
      cwd,
      env: childEnv,
    }))) {
      throw new ReleaseRehearsalAbort('failed');
    }

    if (!await withInterrupt(startDevStep('dev-start', 'Run pnpm dev'))) {
      throw new ReleaseRehearsalAbort(summary.verdict === 'blocked' ? 'blocked' : 'failed');
    }

    await runRequiredCheckpoint({
      id: 'checkpoint-message-handling',
      label: 'Verify Message Handling',
      instructions: [
        `Send one normal Discord prompt that includes the rehearsal slug \`${slug}\` and wait for the first reply.`,
        'Confirm the live Claude runtime replies normally from the source checkout dev process.',
      ],
    });

    await runRequiredCheckpoint({
      id: 'checkpoint-follow-up-reply',
      label: 'Verify Same-Conversation Follow-Up',
      instructions: [
        'In that same Discord conversation, send one follow-up prompt after the first reply.',
        'Confirm the live Claude runtime answers the follow-up normally without losing the existing conversation context.',
      ],
    });

    await runRequiredCheckpoint({
      id: 'checkpoint-task-sync',
      label: 'Verify Task Sync',
      instructions: [
        `Create one rehearsal task titled \`${artifacts.taskTitle}\` through the live Discord path.`,
        'Confirm the task sync path creates or updates the corresponding task thread.',
      ],
    });

    await runRequiredCheckpoint({
      id: 'checkpoint-cron-execution',
      label: 'Verify Cron Execution',
      instructions: [
        `Create one rehearsal cron named \`${artifacts.cronName}\` through the live Discord path.`,
        'Wait for one real execution and confirm the cron posted the expected output.',
      ],
    });

    await withInterrupt(stopDevIfRunning());
    if (!await withInterrupt(startDevStep('dev-restart', 'Restart pnpm dev'))) {
      throw new ReleaseRehearsalAbort(summary.verdict === 'blocked' ? 'blocked' : 'failed');
    }

    await runRequiredCheckpoint({
      id: 'checkpoint-restart-recovery',
      label: 'Verify Restart And Recovery',
      instructions: [
        'Confirm the restarted process reconnects cleanly.',
        'Send one post-restart Discord prompt and confirm normal handling, plus any expected recovery notice if you intentionally interrupted work.',
      ],
    });

    await withInterrupt(stopDevIfRunning());
    shouldConfirmCleanBaseline = true;
  } catch (error) {
    if (error instanceof ReleaseRehearsalAbort) {
      summary.verdict = error.verdict;
    } else if (isInterruptError(error)) {
      summary.verdict = 'blocked';
      summary.steps.push(makeStep(
        'release-rehearsal',
        'Release Rehearsal',
        'blocked',
        error.message,
      ));
    } else {
      summary.verdict = 'failed';
      summary.steps.push(makeStep(
        'release-rehearsal',
        'Release Rehearsal',
        'fail',
        error instanceof Error ? error.message : String(error),
      ));
    }
  } finally {
    await stopDevIfRunning();
  }

  try {
    if (shouldRunCleanup) {
      log('Running teardown...');
      summary.cleanup = await runCleanup();
      const taskCheckpointPassed = getStepStatus(summary.steps, 'checkpoint-task-sync') === 'pass';
      const taskEvidenceFound =
        summary.cleanup.closedTaskIds.length > 0 || summary.cleanup.archivedTaskThreadIds.length > 0;
      const hasTaskCleanupFinding = summary.cleanup.leftovers.some(
        (leftover) => leftover.kind === 'task' || leftover.kind === 'task-thread',
      );
      if (taskCheckpointPassed && !taskEvidenceFound && !hasTaskCleanupFinding) {
        summary.cleanup.leftovers.push({
          kind: 'task',
          id: 'missing-machine-task-evidence',
          name: summary.artifacts.taskTitle,
          reason: 'Task Sync checkpoint passed, but teardown did not observe the named rehearsal task or any archived rehearsal task thread.',
        });
      }

      const cronCheckpointPassed = getStepStatus(summary.steps, 'checkpoint-cron-execution') === 'pass';
      const cronEvidenceFound =
        summary.cleanup.archivedCronThreadIds.length > 0 || summary.cleanup.disabledCronIds.length > 0;
      const hasCronCleanupFinding = summary.cleanup.leftovers.some(
        (leftover) => leftover.kind === 'cron-thread' || leftover.kind === 'cron-record',
      );
      if (cronCheckpointPassed && !cronEvidenceFound && !hasCronCleanupFinding) {
        summary.cleanup.leftovers.push({
          kind: 'cron-thread',
          id: 'missing-machine-cron-evidence',
          name: summary.artifacts.cronName,
          reason: 'Cron Execution checkpoint passed, but teardown did not observe the named rehearsal cron thread or any disabled canonical cron record.',
        });
      }

      if (shouldConfirmCleanBaseline) {
        if (interruptError) {
          summary.steps.push(makeStep(
            'record-chat-artifact-cleanup',
            'Record Chat Artifact Cleanup',
            'skipped',
            `${interruptError.message} Operator note about rehearsal-only message or restart/recovery artifacts was not recorded.`,
          ));
          summary.cleanup.notes.push(
            'Operator note about rehearsal-only message-handling or restart/recovery chat artifacts was not recorded because the rehearsal was interrupted after automated teardown.',
          );
        } else {
          log('Waiting on Record Chat Artifact Cleanup...');
          try {
            const cleanupConfirmation = await withInterrupt(promptCheckpoint({
              id: 'record-chat-artifact-cleanup',
              label: 'Record Chat Artifact Cleanup',
              instructions: [
                'Record whether any rehearsal-only message-handling or restart/recovery Discord artifacts were cleaned up, or were created in a disposable location.',
                `This note does not change the verdict; only rehearsal-owned task, cron, and local-temp artifacts block teardown for \`${slug}\`.`,
              ],
            }));

            const cleanupConfirmed = cleanupConfirmation === 'pass';
            summary.steps.push(makeStep(
              'record-chat-artifact-cleanup',
              'Record Chat Artifact Cleanup',
              cleanupConfirmed ? 'pass' : 'skipped',
              cleanupConfirmed
                ? 'Operator confirmed any rehearsal-only chat or recovery artifacts were cleaned up or confined to a disposable location.'
                : cleanupConfirmation === 'fail'
                  ? 'Operator reported rehearsal-only chat or recovery artifacts may still remain; recorded as an operator note only.'
                  : 'Operator did not confirm the chat-artifact cleanup note; recorded as an operator note only.',
            ));
            summary.cleanup.notes.push(
              cleanupConfirmed
                ? 'Operator confirmed any rehearsal-only message-handling or restart/recovery chat artifacts were cleaned up or confined to a disposable location.'
                : cleanupConfirmation === 'fail'
                  ? 'Operator reported rehearsal-only message-handling or restart/recovery chat artifacts may still remain; this note does not change the teardown verdict because those artifacts are not rehearsal-owned cleanup blockers.'
                  : 'Operator did not confirm the message-handling/restart-recovery chat artifact cleanup note; this does not change the teardown verdict because those artifacts are not rehearsal-owned cleanup blockers.',
            );
          } catch (error) {
            if (isInterruptError(error)) {
              interruptError = error;
              summary.steps.push(makeStep(
                'record-chat-artifact-cleanup',
                'Record Chat Artifact Cleanup',
                'skipped',
                `${error.message} Operator note about rehearsal-only message or restart/recovery artifacts was not recorded.`,
              ));
              summary.cleanup.notes.push(
                'Operator note about rehearsal-only message-handling or restart/recovery chat artifacts was not recorded because the rehearsal was interrupted after automated teardown.',
              );
            } else {
              summary.verdict = 'failed';
              summary.steps.push(makeStep(
                'record-chat-artifact-cleanup',
                'Record Chat Artifact Cleanup',
                'fail',
                error instanceof Error ? error.message : String(error),
              ));
            }
          }
        }
      }

      if (summary.cleanup.leftovers.length > 0) {
        summary.verdict = 'blocked';
        summary.steps.push(makeStep(
          'teardown',
          'Teardown Rehearsal Artifacts',
          'blocked',
          'Cleanup left active or unresolved rehearsal artifacts.',
          { detail: summary.cleanup.leftovers.map((leftover) => `${leftover.kind}:${leftover.id}`).join(', ') },
        ));
      } else {
        summary.steps.push(makeStep(
          'teardown',
          'Teardown Rehearsal Artifacts',
          'pass',
          'Cleanup archived or disabled every rehearsal artifact that was found.',
        ));
      }
    }

    return finish(summary.verdict, summary.verdict === 'pass' ? 0 : 1);
  } finally {
    autoCheckpointDispose?.();
    removeInterruptHandlers();
  }
}

function isMainModule(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return path.resolve(argvPath) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const result = await runReleaseRehearsal();
  process.exit(result.exitCode);
}
