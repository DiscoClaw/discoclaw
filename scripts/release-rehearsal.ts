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

const defaultRoot = path.resolve(import.meta.dirname, '..');

const CLOSEOUT_DIR = path.join('docs', 'release-audit');
const DEV_READY_TIMEOUT_MS = 45_000;
const CRON_DISABLE_SETTLE_MS = 2_000;
const TASK_ARCHIVED_FETCH_LIMIT = 100;
const CRON_ARCHIVED_FETCH_LIMIT = 100;

const SOURCE_CHECKOUT_MARKERS = [
  'package.json',
  'pnpm-lock.yaml',
  path.join('src', 'index.ts'),
  path.join('scripts', 'doctor.ts'),
];

export type ReleaseRehearsalVerdict = 'pass' | 'blocked' | 'failed';
export type ReleaseRehearsalStepStatus = 'pass' | 'fail' | 'blocked' | 'skipped';
export type ReleaseRehearsalCheckpointStatus = 'pass' | 'fail' | 'skipped';

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
  kind: 'task' | 'task-thread' | 'cron-thread' | 'cron-record';
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

export type ReleaseRehearsalDevSession = {
  ready: () => Promise<ReleaseRehearsalCommandResult>;
  stop: () => Promise<ReleaseRehearsalCommandResult>;
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
  ];
}

function previewText(value: string, maxLen = 200): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxLen
    ? normalized
    : `${normalized.slice(0, maxLen - 1)}…`;
}

function commandString(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
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
  return SOURCE_CHECKOUT_MARKERS.every((marker) => existsSync(path.join(repoRoot, marker)));
}

function buildEnvOverrides(repoRoot: string, slug: string) {
  const rehearsalRoot = path.join(os.tmpdir(), 'discoclaw-release-rehearsal', slug);
  const dataDir = path.join(rehearsalRoot, 'data');
  const workspaceDir = path.join(rehearsalRoot, 'workspace');
  const groupsDir = path.join(workspaceDir, 'groups');
  const beadsDir = path.join(workspaceDir, '.beads');
  const taskPrefix = `rr${slug.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-10)}`;

  return {
    repoRoot,
    rehearsalRoot,
    envOverrides: {
      DISCOCLAW_DATA_DIR: dataDir,
      WORKSPACE_CWD: workspaceDir,
      GROUPS_DIR: groupsDir,
      BEADS_DIR: beadsDir,
      DISCOCLAW_TASKS_PREFIX: taskPrefix,
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

async function defaultStartDev(spec: ReleaseRehearsalCommandSpec): Promise<ReleaseRehearsalDevSession> {
  const [command, ...args] = spec.command;
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
    while (Date.now() - startedAt < DEV_READY_TIMEOUT_MS) {
      if (child.exitCode !== undefined) {
        const settled = await child;
        return {
          exitCode: settled.exitCode ?? 1,
          stdout: outputChunks.join(''),
          stderr: '',
        };
      }

      const joined = outputChunks.join('');
      if (
        joined.includes('workspace permissions loaded')
        || joined.includes('resolved bot display name')
        || joined.includes('PID lock acquired')
      ) {
        return {
          exitCode: 0,
          stdout: joined,
          stderr: '',
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return {
      exitCode: child.exitCode ?? 0,
      stdout: outputChunks.join(''),
      stderr: '',
    };
  };

  const stop = async (): Promise<ReleaseRehearsalCommandResult> => {
    if (child.exitCode === undefined) {
      child.kill('SIGINT');
      const killTimer = setTimeout(() => {
        if (child.exitCode === undefined) child.kill('SIGKILL');
      }, 5_000);
      const settled = await child;
      clearTimeout(killTimer);
      return {
        exitCode: settled.exitCode ?? 0,
        stdout: outputChunks.join(''),
        stderr: '',
      };
    }

    const settled = await child;
    return {
      exitCode: settled.exitCode ?? 0,
      stdout: outputChunks.join(''),
      stderr: '',
    };
  };

  return { ready, stop };
}

async function defaultPromptCheckpoint(
  prompt: ReleaseRehearsalCheckpointPrompt,
): Promise<ReleaseRehearsalCheckpointStatus> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Checkpoint "${prompt.label}" requires an interactive TTY.`);
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

function renderCloseoutMarkdown(summary: ReleaseRehearsalSummary): string {
  const lines: string[] = [];
  lines.push('# Claude Release Rehearsal Closeout');
  lines.push('');
  lines.push(`- Verdict: \`${summary.verdict}\``);
  lines.push(`- Repo root: \`${summary.repoRoot}\``);
  lines.push(`- Repo-local env: \`${summary.envPath}\``);
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

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise<void>((resolve) => {
    if (client.isReady()) resolve();
    else client.once('ready', () => resolve());
  });

  const scaffold = await readPersistedScaffoldState(String(env.DISCOCLAW_DATA_DIR ?? ''));
  const preferredGuildId = String(env.DISCORD_GUILD_ID ?? scaffold.guildId ?? '').trim();
  const guild = preferredGuildId
    ? await client.guilds.fetch(preferredGuildId)
    : client.guilds.cache.first() ?? await client.guilds.fetch().then((guilds) => guilds.first() as Guild | undefined);

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
          ctx.childEnv.DISCOCLAW_TASKS_TAG_MAP
          ?? resolveTaskDataPath(dataDir, 'tag-map.json')
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
            if (record.disabled) {
              cleanup.disabledCronIds.push(record.cronId);
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
    }

    if (cleanup.closedTaskIds.length === 0) {
      cleanup.notes.push('No rehearsal tasks were found in the isolated task store.');
    }
    if (cleanup.archivedCronThreadIds.length === 0) {
      cleanup.notes.push('No active rehearsal cron threads were found to archive.');
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
  const promptCheckpoint = deps.promptCheckpoint ?? defaultPromptCheckpoint;
  const cleanupArtifacts = deps.cleanupArtifacts ?? defaultCleanupArtifacts;
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix;

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
        cleanup: {
          closedTaskIds: [],
          archivedTaskThreadIds: [],
          archivedCronThreadIds: [],
          disabledCronIds: [],
          leftovers: [],
          notes: [],
        },
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
    cleanup: {
      closedTaskIds: [],
      archivedTaskThreadIds: [],
      archivedCronThreadIds: [],
      disabledCronIds: [],
      leftovers: [],
      notes: [],
    },
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
      'Current working tree does not match the repo-owned source-checkout markers.',
    ));
    return finish('blocked', 1);
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
  const primaryRuntime = String(repoEnv.PRIMARY_RUNTIME ?? '').trim() || 'claude';
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

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...summary.envOverrides,
  };

  summary.steps.push(makeStep(
    'validate-inputs',
    'Validate Rehearsal Inputs',
    'pass',
    'Source checkout markers, repo-local .env, and PRIMARY_RUNTIME=claude were all confirmed.',
  ));

  let activeDevSession: ReleaseRehearsalDevSession | null = null;
  let activeDevLabel = '';

  const stopDevIfRunning = async () => {
    if (!activeDevSession) return;
    log(`Stopping ${activeDevLabel}...`);
    await activeDevSession.stop();
    activeDevSession = null;
    activeDevLabel = '';
  };

  const runCommandStep = async (spec: ReleaseRehearsalCommandSpec): Promise<boolean> => {
    log(`Running ${spec.label}...`);
    const result = await runCommand(spec);
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

  const runCheckpoint = async (prompt: ReleaseRehearsalCheckpointPrompt): Promise<boolean> => {
    log(`Waiting on ${prompt.label}...`);
    const status = await promptCheckpoint(prompt);
    const stepStatus: ReleaseRehearsalStepStatus =
      status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'skipped';
    summary.steps.push(makeStep(
      prompt.id,
      prompt.label,
      stepStatus,
      status === 'pass'
        ? 'Operator confirmed this checkpoint.'
        : status === 'fail'
          ? 'Operator marked this checkpoint failed.'
          : 'Operator skipped this checkpoint.',
    ));
    if (status === 'fail') summary.verdict = 'failed';
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
    const result = await activeDevSession.ready();
    const ok = result.exitCode === 0;
    summary.steps.push(makeStep(
      id,
      label,
      ok ? 'pass' : 'fail',
      ok ? 'Dev process reached the rehearsal ready boundary.' : 'Dev process failed before reaching the rehearsal ready boundary.',
      {
        command: commandString(spec.command),
        outputPreview: previewText(`${result.stdout}\n${result.stderr}`) || undefined,
      },
    ));
    if (!ok) {
      summary.verdict = 'failed';
      await stopDevIfRunning();
    }
    return ok;
  };

  try {
    if (!await runCommandStep({
      id: 'preflight-blank-machine',
      label: 'Run pnpm preflight:blank-machine',
      command: ['pnpm', 'preflight:blank-machine'],
      cwd,
      env: childEnv,
    })) {
      return finish('failed', 1);
    }

    if (!await runCommandStep({
      id: 'claude-auth-smoke',
      label: 'Run pnpm claude:auth-smoke',
      command: ['pnpm', 'claude:auth-smoke'],
      cwd,
      env: childEnv,
    })) {
      return finish('failed', 1);
    }

    const discordSmokeCommand = ['pnpm', 'discord:smoke-test'];
    const guildId = String(repoEnv.DISCORD_GUILD_ID ?? '').trim();
    if (guildId) {
      discordSmokeCommand.push('--', '--guild-id', guildId);
    }
    if (!await runCommandStep({
      id: 'discord-smoke-test',
      label: 'Run pnpm discord:smoke-test',
      command: discordSmokeCommand,
      cwd,
      env: childEnv,
    })) {
      return finish('failed', 1);
    }

    if (!await runCommandStep({
      id: 'build',
      label: 'Run pnpm build',
      command: ['pnpm', 'build'],
      cwd,
      env: childEnv,
    })) {
      return finish('failed', 1);
    }

    if (!await startDevStep('dev-start', 'Run pnpm dev')) {
      return finish('failed', 1);
    }

    await runCheckpoint({
      id: 'checkpoint-message-handling',
      label: 'Verify Message Handling',
      instructions: [
        `Send one normal Discord prompt that includes the rehearsal slug \`${slug}\`.`,
        'Confirm the live Claude runtime replies normally from the source checkout dev process.',
      ],
    });

    await runCheckpoint({
      id: 'checkpoint-task-sync',
      label: 'Verify Task Sync',
      instructions: [
        `Create one rehearsal task titled \`${artifacts.taskTitle}\` through the live Discord path.`,
        'Confirm the task sync path creates or updates the corresponding task thread.',
      ],
    });

    await runCheckpoint({
      id: 'checkpoint-cron-execution',
      label: 'Verify Cron Execution',
      instructions: [
        `Create one rehearsal cron named \`${artifacts.cronName}\` through the live Discord path.`,
        'Wait for one real execution and confirm the cron posted the expected output.',
      ],
    });

    await stopDevIfRunning();
    if (!await startDevStep('dev-restart', 'Restart pnpm dev')) {
      return finish('failed', 1);
    }

    await runCheckpoint({
      id: 'checkpoint-restart-recovery',
      label: 'Verify Restart And Recovery',
      instructions: [
        'Confirm the restarted process reconnects cleanly.',
        'Send one post-restart Discord prompt and confirm normal handling, plus any expected recovery notice if you intentionally interrupted work.',
      ],
    });

    log('Running teardown...');
    summary.cleanup = await cleanupArtifacts({
      repoRoot: cwd,
      slug,
      childEnv,
      envOverrides: summary.envOverrides,
      artifacts,
      log,
    });

    if (summary.cleanup.leftovers.length > 0) {
      summary.verdict = 'blocked';
      summary.steps.push(makeStep(
        'teardown',
        'Teardown Rehearsal Artifacts',
        'blocked',
        'Cleanup left active or unresolved rehearsal artifacts.',
        { detail: summary.cleanup.leftovers.map((leftover) => `${leftover.kind}:${leftover.id}`).join(', ') },
      ));
      return finish('blocked', 1);
    }

    summary.steps.push(makeStep(
      'teardown',
      'Teardown Rehearsal Artifacts',
      'pass',
      'Cleanup archived or disabled every rehearsal artifact that was found.',
    ));
    return finish(summary.verdict === 'failed' ? 'failed' : 'pass', summary.verdict === 'failed' ? 1 : 0);
  } catch (error) {
    summary.verdict = 'failed';
    summary.steps.push(makeStep(
      'release-rehearsal',
      'Release Rehearsal',
      'fail',
      error instanceof Error ? error.message : String(error),
    ));
    return finish('failed', 1);
  } finally {
    await stopDevIfRunning();
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
