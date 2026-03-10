import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config as loadDotenv } from 'dotenv';
import { getLocalVersion, isNpmManaged } from '../npm-managed.js';
import { isModelTier } from '../runtime/model-tiers.js';
import { getGitHash } from '../version.js';
import type { DashboardServer, DashboardServerOptions } from '../dashboard/server.js';
import type { DoctorContext, DoctorReport, FixResult, InspectOptions } from '../health/config-doctor.js';
import { applyFixes, inspect, KNOWN_RUNTIMES, loadDoctorContext } from '../health/config-doctor.js';
import { DEFAULTS as MODEL_DEFAULTS, type ModelConfig, type ModelRole, saveModelConfig } from '../model-config.js';
import { saveOverrides, type RuntimeOverrides } from '../runtime-overrides.js';
import type { CommandResult, ServiceControlDeps } from '../service-control.js';
import {
  getServiceLogs,
  getServiceStatus,
  restartService,
  normalizeServiceName,
  summarizeServiceStatus,
  truncateCommandOutput,
} from '../service-control.js';

const DASHBOARD_MODEL_ROLES: readonly ModelRole[] = [
  'chat',
  'plan-run',
  'fast',
  'summary',
  'cron',
  'cron-exec',
  'voice',
  'forge-drafter',
  'forge-auditor',
];

const ACTION_MENU = [
  '[1] Refresh',
  '[2] Service status',
  '[3] Service logs',
  '[4] Restart/start service',
  '[5] Run config doctor',
  '[6] Apply doctor fixes',
  '[7] Change model assignment',
  '[q] Quit',
] as const;

export type DashboardModelRow = {
  role: ModelRole;
  effectiveModel: string;
  source: 'override' | 'default';
  overrideValue?: string;
};

export type DashboardSnapshot = {
  cwd: string;
  version: string;
  installMode: DoctorReport['installMode'];
  gitHash: string | null;
  serviceName: string;
  serviceSummary: string;
  doctorSummary: string;
  roles: string[];
  modelOptions: Record<string, string[]>;
  modelRows: DashboardModelRow[];
  configPaths: DoctorReport['configPaths'];
  runtimeOverrides: {
    fastRuntime?: string;
    voiceRuntime?: string;
  };
};

export type DashboardIo = {
  clear(): void;
  write(text: string): void;
  prompt(question: string): Promise<string>;
  close?(): void;
};

export type DashboardDeps = {
  inspect: (opts?: InspectOptions) => Promise<DoctorReport>;
  applyFixes: (report: DoctorReport, opts?: InspectOptions) => Promise<FixResult>;
  loadDoctorContext: (opts?: InspectOptions) => Promise<DoctorContext>;
  saveModelConfig: (filePath: string, config: ModelConfig) => Promise<void>;
  saveOverrides: (filePath: string, overrides: RuntimeOverrides) => Promise<void>;
  runCommand: (cmd: string, args: string[]) => Promise<CommandResult>;
  getLocalVersion: () => string;
  isNpmManaged: () => Promise<boolean>;
  getGitHash: () => Promise<string | null>;
  platform: NodeJS.Platform;
  homeDir: string;
  getUid: () => number;
};

export type RunDashboardOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: DashboardIo;
  deps?: Partial<DashboardDeps>;
  loadEnv?: boolean;
};

function createDefaultDashboardIo(): DashboardIo {
  const rl = readline.createInterface({ input, output });
  return {
    clear() {
      output.write('\x1Bc');
    },
    write(text: string) {
      output.write(text);
      if (!text.endsWith('\n')) output.write('\n');
    },
    prompt(question: string) {
      return rl.question(question);
    },
    close() {
      rl.close();
    },
  };
}

function createDefaultDeps(): DashboardDeps {
  return {
    inspect,
    applyFixes,
    loadDoctorContext,
    saveModelConfig,
    saveOverrides,
    runCommand(cmd: string, args: string[]) {
      return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode: typeof err?.code === 'number' ? err.code : err ? null : 0,
          });
        });
      });
    },
    getLocalVersion,
    isNpmManaged,
    getGitHash,
    platform: process.platform,
    homeDir: os.homedir(),
    getUid: () => process.getuid?.() ?? 501,
  };
}

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<DashboardServer> {
  const serverModule = await import('../dashboard/server.js');
  return serverModule.startDashboardServer(options);
}

export function updateModelConfig(
  currentConfig: ModelConfig,
  role: ModelRole,
  nextModel: string | null,
): ModelConfig {
  const nextConfig: ModelConfig = { ...currentConfig };
  if (nextModel === null) {
    delete nextConfig[role];
    return nextConfig;
  }
  nextConfig[role] = nextModel;
  return nextConfig;
}

export function buildModelRows(ctx: DoctorContext): DashboardModelRow[] {
  return DASHBOARD_MODEL_ROLES.map((role) => {
    const overrideValue = ctx.models[role];
    const fallback = ctx.envDefaults[role] ?? MODEL_DEFAULTS[role] ?? '(unset)';
    const isOverride = overrideValue !== undefined && overrideValue !== fallback;
    return {
      role,
      effectiveModel: overrideValue ?? fallback,
      source: isOverride ? 'override' : 'default',
      overrideValue: isOverride ? overrideValue : undefined,
    };
  });
}

function buildModelOptions(ctx: DoctorContext): Record<string, string[]> {
  const modelOptions: Record<string, string[]> = {};

  for (const role of DASHBOARD_MODEL_ROLES) {
    if (role === 'fast' || role === 'voice') {
      modelOptions[role] = ['fast', 'capable', 'deep', 'default'];
      continue;
    }

    const options: string[] = [];
    const envDefault = ctx.envDefaults[role] ?? MODEL_DEFAULTS[role];
    const overrideValue = ctx.models[role];

    if (envDefault) options.push(envDefault);
    if (overrideValue && overrideValue !== envDefault) options.push(overrideValue);
    options.push('default');

    modelOptions[role] = [...new Set(options)];
  }

  return modelOptions;
}

export function countDoctorSeverities(report: DoctorReport): Record<'error' | 'warn' | 'info', number> {
  return report.findings.reduce<Record<'error' | 'warn' | 'info', number>>(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { error: 0, warn: 0, info: 0 },
  );
}

export function formatDoctorSummary(report: DoctorReport): string {
  const counts = countDoctorSeverities(report);
  return `${report.findings.length} findings (errors=${counts.error}, warnings=${counts.warn}, info=${counts.info})`;
}

function normalizeActionInput(value: string): string {
  return value.trim().toLowerCase();
}

function isModelRole(value: string): value is ModelRole {
  return (DASHBOARD_MODEL_ROLES as readonly string[]).includes(value);
}

function normalizeRuntimeName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  const normalized = trimmed === 'claude_code' ? 'claude' : trimmed;
  return KNOWN_RUNTIMES.has(normalized) ? normalized : undefined;
}

async function confirmAction(io: DashboardIo, prompt: string): Promise<boolean> {
  const answer = normalizeActionInput(await io.prompt(prompt));
  return answer === 'y' || answer === 'yes';
}

function formatCommandResult(result: CommandResult): string {
  return truncateCommandOutput(result.stdout || result.stderr || (result.exitCode === 0 ? 'Command completed.' : 'No output.'));
}

async function promptForModelChange(
  io: DashboardIo,
  ctx: DoctorContext,
  deps: DashboardDeps,
): Promise<string> {
  const rows = buildModelRows(ctx);
  io.write('\nModel roles:');
  for (const row of rows) {
    const sourceLabel = row.source === 'override' ? 'override' : 'default';
    io.write(`  - ${row.role}: ${row.effectiveModel} [${sourceLabel}]`);
  }

  const roleInput = normalizeActionInput(
    await io.prompt(`Role (${DASHBOARD_MODEL_ROLES.join(', ')}): `),
  );
  if (!roleInput) return 'Model change canceled.';
  if (!isModelRole(roleInput)) return `Unknown model role: ${roleInput}`;

  const modelInput = (await io.prompt(
    roleInput === 'fast' || roleInput === 'voice'
      ? 'New model tier (fast, capable, deep; blank cancels, "default" clears the override): '
      : 'New model (blank cancels, "default" clears the override): ',
  )).trim();
  if (!modelInput) return 'Model change canceled.';
  if (/\s/.test(modelInput)) return 'Model names cannot contain whitespace.';

  const clearOverride = modelInput.toLowerCase() === 'default' || modelInput.toLowerCase() === 'reset';
  const runtimeInput = normalizeRuntimeName(modelInput);

  if (clearOverride) {
    const fallback = ctx.envDefaults[roleInput] ?? MODEL_DEFAULTS[roleInput];
    if (!fallback) {
      return `No default model is configured for ${roleInput}.`;
    }
    const nextConfig = updateModelConfig(ctx.models, roleInput, fallback);
    await deps.saveModelConfig(ctx.configPaths.models, nextConfig);
    let clearedRuntimeOverride: 'fastRuntime' | 'voiceRuntime' | null = null;
    if (roleInput === 'fast' && ctx.runtimeOverrides.fastRuntime) {
      const nextOverrides: RuntimeOverrides = { ...ctx.runtimeOverrides };
      delete nextOverrides.fastRuntime;
      await deps.saveOverrides(ctx.configPaths.runtimeOverrides, nextOverrides);
      clearedRuntimeOverride = 'fastRuntime';
    } else if (roleInput === 'voice' && ctx.runtimeOverrides.voiceRuntime) {
      const nextOverrides: RuntimeOverrides = { ...ctx.runtimeOverrides };
      delete nextOverrides.voiceRuntime;
      await deps.saveOverrides(ctx.configPaths.runtimeOverrides, nextOverrides);
      clearedRuntimeOverride = 'voiceRuntime';
    }

    const clearedRuntimeMessage = clearedRuntimeOverride ? ` Cleared ${clearedRuntimeOverride} override.` : '';
    return `Reset ${roleInput} to default: ${fallback}.${clearedRuntimeMessage} Changes take effect on next service restart.`;
  }

  if (runtimeInput) {
    if (roleInput === 'chat') {
      return 'Chat runtime swaps are live-only and do not belong in models.json. Use a concrete model here, or change PRIMARY_RUNTIME in .env and restart.';
    }
    if (roleInput === 'fast' || roleInput === 'voice') {
      return `${roleInput} accepts only model tiers (fast, capable, deep) or "default".`;
    }
    return `Runtime names cannot be stored as the persisted ${roleInput} model. Use a concrete model or "default".`;
  }

  const normalizedModelInput = (roleInput === 'fast' || roleInput === 'voice')
    ? modelInput.toLowerCase()
    : modelInput;
  if ((roleInput === 'fast' || roleInput === 'voice') && !isModelTier(normalizedModelInput)) {
    return `${roleInput} accepts only model tiers (fast, capable, deep) or "default".`;
  }

  const nextConfig = updateModelConfig(ctx.models, roleInput, normalizedModelInput);
  await deps.saveModelConfig(ctx.configPaths.models, nextConfig);
  return `Saved ${roleInput} override: ${normalizedModelInput}. Changes take effect on next service restart.`;
}

export async function collectDashboardSnapshot(
  opts: Pick<RunDashboardOptions, 'cwd' | 'env'> = {},
  deps: DashboardDeps = createDefaultDeps(),
): Promise<DashboardSnapshot> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const inspectOpts = { cwd, env: opts.env ?? process.env };
  const [ctx, report, npmManaged, gitHash] = await Promise.all([
    deps.loadDoctorContext(inspectOpts),
    deps.inspect(inspectOpts),
    deps.isNpmManaged(),
    deps.getGitHash(),
  ]);
  const serviceName = normalizeServiceName(ctx.env.DISCOCLAW_SERVICE_NAME);
  const serviceStatus = await getServiceStatus(serviceName, deps as ServiceControlDeps);
  const serviceSummary = summarizeServiceStatus(serviceStatus, deps.platform);

  return {
    cwd,
    version: deps.getLocalVersion(),
    installMode: npmManaged ? 'npm-managed' : report.installMode,
    gitHash,
    serviceName,
    serviceSummary,
    doctorSummary: formatDoctorSummary(report),
    roles: [...DASHBOARD_MODEL_ROLES],
    modelOptions: buildModelOptions(ctx),
    modelRows: buildModelRows(ctx),
    configPaths: report.configPaths,
    runtimeOverrides: {
      fastRuntime: ctx.runtimeOverrides.fastRuntime,
      voiceRuntime: ctx.runtimeOverrides.voiceRuntime,
    },
  };
}

export function renderDashboard(snapshot: DashboardSnapshot, detail = ''): string {
  const roleWidth = Math.max(...snapshot.modelRows.map((row) => row.role.length), 'voice-runtime'.length, 'fast-runtime'.length);
  const lines: string[] = [
    'Discoclaw Dashboard',
    '===================',
    `cwd: ${snapshot.cwd}`,
    `version: ${snapshot.version}`,
    `install mode: ${snapshot.installMode}`,
    `git hash: ${snapshot.gitHash ?? '(not available)'}`,
    `service: ${snapshot.serviceName} (${snapshot.serviceSummary})`,
    `doctor: ${snapshot.doctorSummary}`,
    '',
    'Model assignments',
    '-----------------',
  ];

  for (const row of snapshot.modelRows) {
    const sourceLabel = row.source === 'override' ? 'override' : 'default';
    lines.push(`${row.role.padEnd(roleWidth)}  ${row.effectiveModel}  [${sourceLabel}]`);
  }

  if (snapshot.runtimeOverrides.fastRuntime) {
    lines.push(`${'fast-runtime'.padEnd(roleWidth)}  ${snapshot.runtimeOverrides.fastRuntime}  [override]`);
  }
  if (snapshot.runtimeOverrides.voiceRuntime) {
    lines.push(`${'voice-runtime'.padEnd(roleWidth)}  ${snapshot.runtimeOverrides.voiceRuntime}  [override]`);
  }

  lines.push(
    '',
    'Config paths',
    '------------',
    `env: ${snapshot.configPaths.env}`,
    `models: ${snapshot.configPaths.models}`,
    `runtime overrides: ${snapshot.configPaths.runtimeOverrides}`,
    '',
    'Actions',
    '-------',
    ...ACTION_MENU,
  );

  if (detail.trim()) {
    lines.push('', 'Last action', '-----------', truncateCommandOutput(detail));
  }

  return `${lines.join('\n')}\n`;
}

export async function runDashboard(options: RunDashboardOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const deps: DashboardDeps = { ...createDefaultDeps(), ...options.deps };
  const io = options.io ?? createDefaultDashboardIo();
  const inspectOpts = { cwd, env: options.env ?? process.env };

  if (!options.io && !input.isTTY) {
    console.error('discoclaw dashboard requires an interactive terminal.');
    process.exit(1);
  }

  if (options.loadEnv !== false) {
    loadDotenv({ path: path.join(cwd, '.env') });
  }

  let detail = 'Interactive admin surface for service actions, config doctor, and persisted model overrides.';

  try {
    while (true) {
      const snapshot = await collectDashboardSnapshot({ cwd, env: inspectOpts.env }, deps);
      io.clear();
      io.write(renderDashboard(snapshot, detail));

      const action = normalizeActionInput(await io.prompt('\nSelect action: '));
      if (action === 'q' || action === 'quit' || action === 'exit') return;

      if (action === '1' || action === 'refresh' || action === 'r') {
        detail = 'Dashboard refreshed.';
        continue;
      }

      if (action === '2' || action === 'status' || action === 's') {
        const result = await getServiceStatus(snapshot.serviceName, deps as ServiceControlDeps);
        detail = formatCommandResult(result);
        continue;
      }

      if (action === '3' || action === 'logs' || action === 'l') {
        const result = await getServiceLogs(snapshot.serviceName, deps as ServiceControlDeps);
        detail = formatCommandResult(result);
        continue;
      }

      if (action === '4' || action === 'restart') {
        const confirmed = await confirmAction(io, `Restart/start ${snapshot.serviceName}? [y/N]: `);
        if (!confirmed) {
          detail = 'Restart/start canceled.';
          continue;
        }
        const result = await restartService(snapshot.serviceName, deps as ServiceControlDeps);
        detail = result.exitCode === 0
          ? `Restart/start requested for ${snapshot.serviceName}.\n\n${formatCommandResult(result)}`
          : `Service action failed for ${snapshot.serviceName} (exit ${result.exitCode ?? 'unknown'}).\n\n${formatCommandResult(result)}`;
        continue;
      }

      if (action === '5' || action === 'doctor' || action === 'd') {
        const report = await deps.inspect(inspectOpts);
        detail = [
          `Doctor report: ${formatDoctorSummary(report)}`,
          '',
          ...report.findings.map((finding) => `[${finding.severity}] ${finding.id}: ${finding.message}`),
        ].join('\n').trim();
        if (report.findings.length === 0) detail = 'Doctor report: no findings.';
        continue;
      }

      if (action === '6' || action === 'fix' || action === 'doctor-fix') {
        const report = await deps.inspect(inspectOpts);
        const autoFixableCount = report.findings.filter((finding) => finding.autoFixable).length;
        if (autoFixableCount === 0) {
          detail = 'No auto-fixable doctor findings.';
          continue;
        }
        const confirmed = await confirmAction(io, `Apply ${autoFixableCount} auto-fixable doctor finding(s)? [y/N]: `);
        if (!confirmed) {
          detail = 'Doctor fixes canceled.';
          continue;
        }
        const result = await deps.applyFixes(report, inspectOpts);
        detail = [
          `Applied: ${result.applied.length}`,
          `Skipped: ${result.skipped.length}`,
          `Errors: ${result.errors.length}`,
          result.applied.length ? `Applied IDs: ${result.applied.join(', ')}` : '',
          result.skipped.length
            ? `Skipped IDs: ${result.skipped.map((entry) => `${entry.id} (${entry.reason})`).join(', ')}`
            : '',
          result.errors.length
            ? `Errors: ${result.errors.map((entry) => `${entry.id} (${entry.message})`).join(', ')}`
            : '',
        ].filter(Boolean).join('\n');
        continue;
      }

      if (action === '7' || action === 'model' || action === 'models' || action === 'm') {
        const ctx = await deps.loadDoctorContext(inspectOpts);
        detail = await promptForModelChange(io, ctx, deps);
        continue;
      }

      detail = `Unknown action: ${action || '(empty input)'}`;
    }
  } finally {
    io.close?.();
  }
}
