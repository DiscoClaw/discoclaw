import {
  doctorManagedBrowser,
  setupManagedBrowser,
} from '../browser/managed-browser.js';
import type {
  BrowserCliCommandOptions,
  BrowserCliDeps,
  BrowserCliIssue,
  BrowserCliReport,
} from '../cli/index.js';

export type BrowserCommand =
  | { action: 'help' }
  | { action: 'setup' }
  | { action: 'doctor' }
  | { action: 'launch'; headless: boolean };

export type BrowserCommandDeps = Pick<BrowserCliDeps, 'setup' | 'doctor'>;

const defaultDeps: BrowserCommandDeps = {
  setup: setupManagedBrowser,
  doctor: doctorManagedBrowser,
};

export function parseBrowserCommand(content: string): BrowserCommand | null {
  const tokens = String(content ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0]!.toLowerCase() !== '!browser') return null;

  if (tokens.length === 1) return { action: 'help' };

  const subcommand = tokens[1]!.toLowerCase();
  if (subcommand === 'help' && tokens.length === 2) return { action: 'help' };
  if (subcommand === 'setup' && tokens.length === 2) return { action: 'setup' };
  if (subcommand === 'doctor' && tokens.length === 2) return { action: 'doctor' };
  if (subcommand === 'launch' && tokens.length === 2) return { action: 'launch', headless: false };
  if (
    subcommand === 'launch' &&
    tokens.length === 3 &&
    (tokens[2]!.toLowerCase() === '--headless' || tokens[2]!.toLowerCase() === 'headless')
  ) {
    return { action: 'launch', headless: true };
  }

  return null;
}

export function renderBrowserHelp(): string {
  return [
    '**!browser commands:**',
    '- `!browser setup` - create Discoclaw\'s managed browser profile and explain the one-time login flow',
    '- `!browser doctor` - inspect readiness, storage enforcement, and current managed-profile blockers',
    '- `!browser launch` - print the exact local headed launch command for the managed profile',
    '- `!browser launch --headless` - print the exact local headless launch command for the same profile',
    '- `!browser help` - this message',
  ].join('\n');
}

export function renderBrowserSetupReport(report: BrowserCliReport): string {
  const lines = [
    '**Managed browser setup**',
    report.summary,
    `Readiness: ${report.ok ? 'ready' : 'blocked'}`,
    `Managed profile dir: ${formatCode(report.paths?.profileDir)}`,
    `State file: ${formatCode(report.paths?.stateFile)}`,
    'Flow:',
    '- Discoclaw manages one dedicated browser profile directly. No helper daemon or localhost control service is used.',
    '- Run `discoclaw browser launch` locally to open that profile in headed Chrome/Chromium for one-time login.',
    '- Keep the browser open until Discoclaw verifies CDP, then close it when finished.',
    '- Reuse the same profile later with `discoclaw browser launch` or `discoclaw browser launch --headless`.',
  ];

  appendCommonReportDetails(lines, report, { includeCurrentState: false });
  appendIssueSection(lines, report.issues);
  appendNextSteps(lines, report.nextSteps);
  return lines.join('\n');
}

export function renderBrowserDoctorReport(report: BrowserCliReport): string {
  const lines = [
    '**Managed browser doctor**',
    report.summary,
    `Readiness: ${report.ok ? 'ready' : 'blocked'}`,
    `Current state: ${describeDoctorState(report)}`,
  ];

  appendCommonReportDetails(lines, report, { includeCurrentState: true });
  appendIssueSection(lines, report.issues);
  appendNextSteps(lines, report.nextSteps);
  return lines.join('\n');
}

export function renderBrowserLaunchGuidance(
  report: BrowserCliReport,
  options: { headless?: boolean } = {},
): string {
  const headless = options.headless === true;
  const primaryCommand = headless ? 'discoclaw browser launch --headless' : 'discoclaw browser launch';
  const alternateCommand = headless ? 'discoclaw browser launch' : 'discoclaw browser launch --headless';
  const lines = [
    '**Managed browser launch**',
    'Discord does not launch the browser for you. Run this locally on the Discoclaw machine:',
    renderShellCommand(primaryCommand),
    `Managed profile dir: ${formatCode(report.paths?.profileDir)}`,
    `State file: ${formatCode(report.paths?.stateFile)}`,
    headless
      ? `Headed login command: \`${alternateCommand}\``
      : 'Use this headed command for the one-time login window; Discoclaw then verifies CDP against the same profile.',
    `Alternate launch: \`${alternateCommand}\``,
  ];

  appendCommonReportDetails(lines, report, { includeCurrentState: true });
  appendIssueSection(lines, report.issues, {
    emptyHeading: 'Current blockers',
    warnHeading: 'Current blockers',
  });
  return lines.join('\n');
}

export async function handleBrowserCommand(
  command: BrowserCommand,
  options: BrowserCliCommandOptions,
  deps: BrowserCommandDeps = defaultDeps,
): Promise<string> {
  if (command.action === 'help') return renderBrowserHelp();
  if (command.action === 'setup') {
    const report = await deps.setup(options);
    return renderBrowserSetupReport(report);
  }
  if (command.action === 'doctor') {
    const report = await deps.doctor(options);
    return renderBrowserDoctorReport(report);
  }

  const report = await deps.doctor(options);
  return renderBrowserLaunchGuidance(report, { headless: command.headless });
}

function appendCommonReportDetails(
  lines: string[],
  report: BrowserCliReport,
  options: { includeCurrentState: boolean },
): void {
  if (report.installMode) {
    lines.push(`Install mode: ${report.installMode}`);
  }
  if (report.storageRule) {
    lines.push(`Storage rule: ${report.storageRule}`);
  }
  if (report.executablePath !== undefined) {
    lines.push(`Browser executable: ${report.executablePath ?? 'not found'}`);
  }
  if (report.paths?.dataDir) {
    lines.push(`Managed data dir: ${formatCode(report.paths.dataDir)}`);
  }
  if (options.includeCurrentState && report.launch?.cdpUrl) {
    lines.push(`Verified CDP endpoint: ${formatCode(report.launch.cdpUrl)}`);
  }
}

function appendIssueSection(
  lines: string[],
  issues: BrowserCliIssue[] | undefined,
  options: {
    emptyHeading?: string;
    warnHeading?: string;
  } = {},
): void {
  const entries = issues ?? [];
  if (entries.length === 0) {
    lines.push(`${options.emptyHeading ?? 'Blockers'}: none`);
    return;
  }

  const hasError = entries.some((issue) => issue.severity === 'error');
  lines.push(`${hasError ? 'Blockers' : options.warnHeading ?? 'Notes'}:`);
  for (const issue of entries) {
    lines.push(`- ${formatIssue(issue)}`);
  }
}

function appendNextSteps(lines: string[], nextSteps: string[] | undefined): void {
  const entries = nextSteps ?? [];
  if (entries.length === 0) return;
  lines.push('Next steps:');
  for (const step of entries) {
    lines.push(`- ${step}`);
  }
}

function describeDoctorState(report: BrowserCliReport): string {
  const issues = report.issues ?? [];
  if (issues.some((issue) => issue.code === 'profile_locked')) {
    return 'managed profile appears to be locked by another browser process';
  }
  if (issues.some((issue) => issue.code === 'stale_launcher_state')) {
    return 'stored launcher state exists but is stale or not verified against CDP';
  }
  if (issues.some((issue) => issue.code === 'storage_rejected')) {
    return 'storage configuration is rejected by the managed-browser rule';
  }
  if (issues.some((issue) => issue.code === 'browser_not_found' || issue.code === 'browser_executable_missing')) {
    return 'Chrome/Chromium executable is not currently ready';
  }
  return 'no blockers detected for the managed profile';
}

function formatIssue(issue: BrowserCliIssue): string {
  const parts = [`[${issue.severity.toUpperCase()}] ${issue.message}`];
  if (issue.detail) parts.push(`Detail: ${issue.detail}`);
  if (issue.recommendation) parts.push(`Fix: ${issue.recommendation}`);
  return parts.join(' ');
}

function renderShellCommand(command: string): string {
  return `\`\`\`bash\n${command}\n\`\`\``;
}

function formatCode(value: string | undefined): string {
  return value ? `\`${value}\`` : '`(unknown)`';
}
