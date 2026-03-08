import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config as loadDotenv } from 'dotenv';
import type { DoctorContext, DoctorReport, FixResult, InspectOptions } from '../health/config-doctor.js';
import { applyFixes, inspect, loadDoctorContext } from '../health/config-doctor.js';
import { DEFAULTS as MODEL_DEFAULTS, type ModelConfig, type ModelRole, saveModelConfig } from '../model-config.js';
import type { CommandResult, ServiceControlDeps } from '../service-control.js';
import {
  normalizeServiceName,
  probeServiceSummary,
  runServiceAction,
  truncateCommandOutput,
} from '../service-control.js';

const DASHBOARD_MODEL_ROLES: readonly ModelRole[] = [
  'chat',
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
  installMode: DoctorReport['installMode'];
  serviceName: string;
  serviceSummary: string;
  doctorSummary: string;
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
  runCommand: (cmd: string, args: string[]) => Promise<CommandResult>;
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
    platform: process.platform,
    homeDir: os.homedir(),
    getUid: () => process.getuid?.() ?? 501,
  };
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
    return {
      role,
      effectiveModel: overrideValue ?? fallback,
      source: overrideValue ? 'override' : 'default',
      overrideValue,
    };
  });
}

function countDoctorSeverities(report: DoctorReport): Record<'error' | 'warn' | 'info', number> {
  return report.findings.reduce<Record<'error' | 'warn' | 'info', number>>(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { error: 0, warn: 0, info: 0 },
  );
}

function formatDoctorSummary(report: DoctorReport): string {
  const counts = countDoctorSeverities(report);
  return `${report.findings.length} findings (errors=${counts.error}, warnings=${counts.warn}, info=${counts.info})`;
}

function normalizeActionInput(value: string): string {
  return value.trim().toLowerCase();
}

function isModelRole(value: string): value is ModelRole {
  return (DASHBOARD_MODEL_ROLES as readonly string[]).includes(value);
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
    'New model (blank cancels, "default" clears the override): ',
  )).trim();
  if (!modelInput) return 'Model change canceled.';
  if (/\s/.test(modelInput)) return 'Model names cannot contain whitespace.';

  const clearOverride = modelInput.toLowerCase() === 'default' || modelInput.toLowerCase() === 'reset';
  const nextConfig = updateModelConfig(ctx.models, roleInput, clearOverride ? null : modelInput);
  await deps.saveModelConfig(ctx.configPaths.models, nextConfig);

  if (clearOverride) {
    const fallback = ctx.envDefaults[roleInput] ?? MODEL_DEFAULTS[roleInput] ?? '(unset)';
    return `Cleared ${roleInput} override. Effective model: ${fallback}.`;
  }

  return `Saved ${roleInput} override: ${modelInput}.`;
}

export async function collectDashboardSnapshot(
  opts: Pick<RunDashboardOptions, 'cwd' | 'env'> = {},
  deps: DashboardDeps = createDefaultDeps(),
): Promise<DashboardSnapshot> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const inspectOpts = { cwd, env: opts.env ?? process.env };
  const [ctx, report] = await Promise.all([
    deps.loadDoctorContext(inspectOpts),
    deps.inspect(inspectOpts),
  ]);
  const serviceName = normalizeServiceName(ctx.env.DISCOCLAW_SERVICE_NAME);
  const serviceSummary = await probeServiceSummary(serviceName, deps as ServiceControlDeps);

  return {
    cwd,
    installMode: report.installMode,
    serviceName,
    serviceSummary,
    doctorSummary: formatDoctorSummary(report),
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
    `install mode: ${snapshot.installMode}`,
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

  let detail = 'Interactive admin surface for service actions, doctor, and model overrides.';

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
        detail = await runServiceAction('status', snapshot.serviceName, deps as ServiceControlDeps);
        continue;
      }

      if (action === '3' || action === 'logs' || action === 'l') {
        detail = await runServiceAction('logs', snapshot.serviceName, deps as ServiceControlDeps);
        continue;
      }

      if (action === '4' || action === 'restart') {
        detail = await runServiceAction('restart', snapshot.serviceName, deps as ServiceControlDeps);
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
