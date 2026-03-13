#!/usr/bin/env tsx

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import util from 'node:util';
import { config as loadDotenv } from 'dotenv';
import { parseConfig } from '../src/config.js';
import { ForgeOrchestrator } from '../src/discord/forge-commands.js';
import { findPlanFile, parsePlanFileHeader, resolvePlanHeaderTaskId } from '../src/discord/plan-commands.js';
import { getSection, parsePlan } from '../src/discord/plan-parser.js';
import { wrapRuntimeWithGlobalPolicies, resolveForgeRuntimes } from '../src/index.runtime.js';
import { DEFAULTS as MODEL_DEFAULTS, loadModelConfig, resolveModelsJsonPath } from '../src/model-config.js';
import { initTierOverrides } from '../src/runtime/model-tiers.js';
import { createCodexCliRuntime } from '../src/runtime/codex-cli.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { resolveTaskDataPath, migrateLegacyTaskDataFile } from '../src/tasks/path-defaults.js';
import { TaskStore } from '../src/tasks/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export type ForgeNativeReproArgs = {
  fromPlan?: string;
  description?: string;
  taskId?: string;
  contextFile?: string;
  outDir?: string;
  dryRun: boolean;
  traceNotifications: boolean;
  help: boolean;
};

export type PlanReplaySeed = {
  description: string;
  taskId?: string;
  context?: string;
};

type JsonRecord = Record<string, unknown>;

type TraceLogger = {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

type TraceWriter = {
  tracePath: string;
  write(type: string, payload: JsonRecord): void;
  close(): Promise<void>;
};

function usage(): string {
  return [
    'Usage: pnpm forge:repro -- [options]',
    '',
    'Required:',
    '  --from-plan <plan-id|file>   Replay using the saved plan title/task/context',
    '  or',
    '  --description <text>         Run a fresh forge repro from a direct description',
    '',
    'Optional:',
    '  --task-id <ws-1234>          Reuse an existing task ID',
    '  --context-file <path>        Append extra context from a file',
    '  --out-dir <dir>              Base directory for trace output',
    '  --trace-notifications        Log every native app-server notification/reset',
    '  --dry-run                    Resolve inputs/config without running forge',
    '  --help                       Show this help',
  ].join('\n');
}

export function parseForgeNativeReproArgs(argv: readonly string[]): ForgeNativeReproArgs {
  const args: ForgeNativeReproArgs = {
    dryRun: false,
    traceNotifications: false,
    help: false,
  };

  const expectValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--trace-notifications') {
      args.traceNotifications = true;
      continue;
    }

    const [flag, inlineValue] = arg.split('=', 2);
    if (flag === '--from-plan') {
      args.fromPlan = inlineValue ?? expectValue(flag, i);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (flag === '--description') {
      args.description = inlineValue ?? expectValue(flag, i);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (flag === '--task-id') {
      args.taskId = inlineValue ?? expectValue(flag, i);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (flag === '--context-file') {
      args.contextFile = inlineValue ?? expectValue(flag, i);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (flag === '--out-dir') {
      args.outDir = inlineValue ?? expectValue(flag, i);
      if (inlineValue === undefined) i++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export function derivePlanReplaySeed(content: string): PlanReplaySeed {
  const parsed = parsePlan(content);
  const header = parsePlanFileHeader(content);
  const description = parsed.title.trim();
  if (!description) {
    throw new Error('Plan is missing a `# Plan:` title');
  }

  const context = getSection(parsed, 'Context').trim() || undefined;
  const taskId = header ? resolvePlanHeaderTaskId(header) || undefined : undefined;
  return { description, taskId, context };
}

function joinContextParts(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  if (filtered.length === 0) return undefined;
  return filtered.join('\n\n');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'run';
}

function formatPathTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function normalizeLogArgs(args: unknown[]): { message: string; payload?: unknown } {
  if (args.length === 0) return { message: '' };
  if (args.length === 1) {
    return typeof args[0] === 'string'
      ? { message: args[0] }
      : { message: util.inspect(args[0], { depth: 5, breakLength: 120 }), payload: args[0] };
  }
  if (typeof args[1] === 'string') {
    return { message: args[1], payload: args[0] };
  }
  if (typeof args[0] === 'string') {
    return { message: args[0], payload: args[1] };
  }
  return {
    message: util.inspect(args, { depth: 5, breakLength: 120 }),
    payload: args,
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, current) => {
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
        };
      }
      if (typeof current === 'bigint') return current.toString();
      return current;
    },
  );
}

function createTraceWriter(runDir: string): TraceWriter {
  const tracePath = path.join(runDir, 'trace.jsonl');
  const stream = fs.createWriteStream(tracePath, { flags: 'a', encoding: 'utf8' });
  return {
    tracePath,
    write(type, payload) {
      const record = { at: new Date().toISOString(), type, ...payload };
      stream.write(stringifyJson(record) + '\n');
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.end(() => resolve());
      });
    },
  };
}

function createTraceLogger(writer: TraceWriter): TraceLogger {
  const emit = (level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]) => {
    const { message, payload } = normalizeLogArgs(args);
    writer.write('log', { level, message, payload });
    const line = `[${level}] ${message}`;
    if (payload === undefined) {
      if (level === 'error' || level === 'warn') {
        console.error(line);
      } else {
        console.log(line);
      }
      return;
    }
    const formattedPayload = util.inspect(payload, {
      depth: 6,
      breakLength: 140,
      colors: false,
      maxArrayLength: 20,
    });
    if (level === 'error' || level === 'warn') {
      console.error(`${line} ${formattedPayload}`);
    } else {
      console.log(`${line} ${formattedPayload}`);
    }
  };

  return {
    debug(...args: unknown[]) {
      emit('debug', args);
    },
    info(...args: unknown[]) {
      emit('info', args);
    },
    warn(...args: unknown[]) {
      emit('warn', args);
    },
    error(...args: unknown[]) {
      emit('error', args);
    },
  };
}

async function resolvePlanSource(
  fromPlan: string,
  plansDir: string,
): Promise<{ filePath: string; headerPlanId?: string; seed: PlanReplaySeed }> {
  const directPath = path.resolve(process.cwd(), fromPlan);
  const fromFile = async (filePath: string) => {
    const content = await fsp.readFile(filePath, 'utf8');
    const header = parsePlanFileHeader(content);
    return {
      filePath,
      headerPlanId: header?.planId,
      seed: derivePlanReplaySeed(content),
    };
  };

  try {
    const stat = await fsp.stat(directPath);
    if (stat.isFile()) {
      return fromFile(directPath);
    }
  } catch {
    // Fall through to plan lookup.
  }

  const found = await findPlanFile(plansDir, fromPlan);
  if (!found) {
    throw new Error(`Plan not found: ${fromPlan}`);
  }
  const content = await fsp.readFile(found.filePath, 'utf8');
  return {
    filePath: found.filePath,
    headerPlanId: found.header.planId,
    seed: derivePlanReplaySeed(content),
  };
}

async function loadContextFile(contextFile: string | undefined): Promise<string | undefined> {
  if (!contextFile) return undefined;
  const filePath = path.resolve(process.cwd(), contextFile);
  const raw = await fsp.readFile(filePath, 'utf8');
  return raw.trim() || undefined;
}

async function loadForgeModels(
  modelsJsonPath: string,
  cfg: ReturnType<typeof parseConfig>['config'],
  log: TraceLogger,
): Promise<{ runtimeModel: string; drafterModel?: string; auditorModel?: string }> {
  let runtimeModel = cfg.runtimeModel;
  let drafterModel = cfg.forgeDrafterModel;
  let auditorModel = cfg.forgeAuditorModel;

  const modelLoadResult = await loadModelConfig(modelsJsonPath, (msg, data) => log.warn(data ?? {}, msg));
  if (modelLoadResult.status === 'loaded') {
    const modelConfig = modelLoadResult.config;
    if (modelConfig['chat']) runtimeModel = modelConfig['chat'];
    if (modelConfig['forge-drafter']) drafterModel = modelConfig['forge-drafter'];
    if (modelConfig['forge-auditor']) auditorModel = modelConfig['forge-auditor'];
    return { runtimeModel, drafterModel, auditorModel };
  }

  if (modelLoadResult.status === 'corrupt') {
    log.warn({ modelsJsonPath, error: modelLoadResult.error }, 'forge-repro: models.json corrupt, using env defaults');
  }
  return {
    runtimeModel,
    drafterModel: drafterModel ?? MODEL_DEFAULTS['forge-drafter'],
    auditorModel: auditorModel ?? MODEL_DEFAULTS['forge-auditor'],
  };
}

async function main(): Promise<void> {
  process.chdir(projectRoot);
  loadDotenv({ path: path.join(projectRoot, '.env') });

  const args = parseForgeNativeReproArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (!args.fromPlan && !args.description) {
    throw new Error('Pass either --from-plan or --description');
  }

  if (args.fromPlan && args.description) {
    throw new Error('Use either --from-plan or --description, not both');
  }

  const parsedConfig = parseConfig(process.env);
  initTierOverrides(process.env);

  const cfg = parsedConfig.config;
  const dataDir = cfg.dataDir;
  const defaultWorkspaceCwd = dataDir
    ? path.join(dataDir, 'workspace')
    : path.join(projectRoot, 'workspace');
  const workspaceCwd = cfg.workspaceCwdOverride || defaultWorkspaceCwd;
  const plansDir = path.join(workspaceCwd, 'plans');

  const labelSeed = args.description ?? args.fromPlan ?? 'forge-native-repro';
  const baseOutDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.join(workspaceCwd, 'diagnostics', 'forge-native-repro');
  const runDir = path.join(baseOutDir, `${formatPathTimestamp()}-${slugify(labelSeed)}`);
  await fsp.mkdir(runDir, { recursive: true });

  const writer = createTraceWriter(runDir);
  const log = createTraceLogger(writer);

  for (const warning of parsedConfig.warnings) {
    log.warn(warning);
  }
  for (const info of parsedConfig.infos) {
    log.info(info);
  }

  if (cfg.primaryRuntime !== 'codex') {
    throw new Error(`forge-native-repro currently supports PRIMARY_RUNTIME=codex only (found ${cfg.primaryRuntime})`);
  }

  const planSource = args.fromPlan
    ? await resolvePlanSource(args.fromPlan, plansDir)
    : undefined;
  const contextFromFile = await loadContextFile(args.contextFile);
  const description = args.description ?? planSource?.seed.description;
  if (!description) {
    throw new Error('Could not resolve a forge description');
  }

  const existingTaskId = args.taskId ?? planSource?.seed.taskId;
  const context = joinContextParts([
    planSource?.seed.context ? `Repro seed context from ${planSource.headerPlanId ?? path.basename(planSource.filePath)}:\n${planSource.seed.context}` : undefined,
    contextFromFile ? `Extra context from ${path.resolve(process.cwd(), args.contextFile!)}:\n${contextFromFile}` : undefined,
  ]);

  const tasksDataRoot = dataDir ?? path.join(projectRoot, 'data');
  const tasksPersistPath =
    resolveTaskDataPath(tasksDataRoot, 'tasks.jsonl')
    ?? path.join(tasksDataRoot, 'tasks', 'tasks.jsonl');
  await fsp.mkdir(path.dirname(tasksPersistPath), { recursive: true });
  const tasksMigration = await migrateLegacyTaskDataFile(tasksDataRoot, 'tasks.jsonl');
  if (tasksMigration.migrated) {
    log.warn(
      { from: tasksMigration.fromPath, to: tasksMigration.toPath },
      'forge-repro: migrated legacy task store',
    );
  }

  const taskStore = new TaskStore({ prefix: cfg.tasksPrefix, persistPath: tasksPersistPath });
  await taskStore.load();

  const modelsJsonPath = resolveModelsJsonPath(dataDir, projectRoot);
  const forgeModels = await loadForgeModels(modelsJsonPath, cfg, log);

  const codexRuntimeRaw = createCodexCliRuntime({
    codexBin: cfg.codexBin,
    defaultModel: cfg.codexModel,
    streamStallTimeoutMs: cfg.streamStallTimeoutMs,
    progressStallTimeoutMs: cfg.progressStallTimeoutMs,
    dangerouslyBypassApprovalsAndSandbox: cfg.codexDangerouslyBypassApprovalsAndSandbox,
    disableSessions: cfg.codexDisableSessions,
    verbosePreview: cfg.codexVerbosePreview,
    itemTypeDebug: cfg.codexItemTypeDebug,
    traceNotifications: args.traceNotifications,
    appendSystemPrompt: cfg.appendSystemPrompt,
    log,
  });
  const codexRuntime = wrapRuntimeWithGlobalPolicies({
    runtime: codexRuntimeRaw,
    maxConcurrentInvocations: cfg.maxConcurrentInvocations,
    log,
    env: process.env,
    globalSupervisorEnabled: cfg.globalSupervisorEnabled,
    globalSupervisorAuditStream: cfg.globalSupervisorAuditStream,
    globalSupervisorLimits: {
      maxCycles: cfg.globalSupervisorMaxCycles,
      maxRetries: cfg.globalSupervisorMaxRetries,
      maxEscalationLevel: cfg.globalSupervisorMaxEscalationLevel,
      maxTotalEvents: cfg.globalSupervisorMaxTotalEvents,
      maxWallTimeMs: cfg.globalSupervisorMaxWallTimeMs,
    },
  });

  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register('codex', codexRuntime);
  const { drafterRuntime, auditorRuntime } = resolveForgeRuntimes({
    primaryRuntimeName: cfg.primaryRuntime,
    primaryRuntime: codexRuntime,
    forgeDrafterRuntime: cfg.forgeDrafterRuntime,
    forgeAuditorRuntime: cfg.forgeAuditorRuntime,
    runtimeRegistry,
    log,
  });

  const metadata = {
    generatedAt: new Date().toISOString(),
    cwd: projectRoot,
    workspaceCwd,
    plansDir,
    runDir,
    tracePath: writer.tracePath,
    description,
    existingTaskId,
    contextLength: context?.length ?? 0,
    args,
    planSource: planSource
      ? {
        filePath: planSource.filePath,
        planId: planSource.headerPlanId,
      }
      : null,
    runtime: {
      primaryRuntime: cfg.primaryRuntime,
      drafterRuntime: drafterRuntime?.id ?? codexRuntime.id,
      auditorRuntime: auditorRuntime?.id ?? codexRuntime.id,
      runtimeModel: forgeModels.runtimeModel,
      drafterModel: forgeModels.drafterModel,
      auditorModel: forgeModels.auditorModel,
      traceNotifications: args.traceNotifications,
    },
  };
  await fsp.writeFile(path.join(runDir, 'metadata.json'), stringifyJson(metadata) + '\n', 'utf8');
  writer.write('metadata', metadata);

  if (args.dryRun) {
    console.log(`Dry run complete.\nTrace dir: ${runDir}\nTrace file: ${writer.tracePath}`);
    await writer.close();
    return;
  }

  const orchestrator = new ForgeOrchestrator({
    runtime: codexRuntime,
    drafterRuntime,
    auditorRuntime,
    model: forgeModels.runtimeModel,
    cwd: projectRoot,
    workspaceCwd,
    taskStore,
    plansDir,
    maxAuditRounds: cfg.forgeMaxAuditRounds,
    progressThrottleMs: cfg.forgeProgressThrottleMs,
    timeoutMs: cfg.forgeTimeoutMs,
    planForgeHeartbeatIntervalMs: cfg.planForgeHeartbeatIntervalMs,
    drafterModel: forgeModels.drafterModel,
    auditorModel: forgeModels.auditorModel,
    log,
    ...(existingTaskId ? { existingTaskId } : {}),
  });

  const handleSignal = (signal: NodeJS.Signals) => {
    writer.write('signal', { signal });
    log.warn({ signal }, 'forge-repro: cancellation requested');
    orchestrator.requestCancel(signal);
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    writer.write('run_started', {
      description,
      existingTaskId,
      contextPreview: context?.slice(0, 500),
    });

    const result = await orchestrator.run(
      description,
      async (message, opts) => {
        writer.write('progress', { message, force: Boolean(opts?.force) });
        console.log(message);
      },
      context,
      (event) => {
        writer.write('engine_event', { event });
      },
    );

    writer.write('run_result', { result });
    await fsp.writeFile(path.join(runDir, 'result.json'), stringifyJson(result) + '\n', 'utf8');
    console.log(`Forge repro complete.\nTrace dir: ${runDir}\nTrace file: ${writer.tracePath}`);
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await writer.close();
  }
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryHref) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
