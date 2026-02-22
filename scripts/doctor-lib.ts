import { validateSnowflake } from '../src/validate.js';

export type DoctorCheckResult = {
  ok: boolean;
  label: string;
  hint?: string;
  /** True when the result is informational rather than a pass/fail (e.g. a missing binary that is not needed). */
  info?: boolean;
};

export function parseBooleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): { value: boolean; error?: string } {
  const raw = (env[name] ?? '').trim();
  if (!raw) return { value: defaultValue };

  const normalized = raw.toLowerCase();
  if (normalized === '1' || normalized === 'true') return { value: true };
  if (normalized === '0' || normalized === 'false') return { value: false };
  return { value: defaultValue, error: `Got "${raw}"` };
}

/**
 * Normalize a raw env value to a canonical runtime name.
 * Mirrors parseRuntimeName in src/config.ts: lowercase + claude_code → claude alias.
 */
function normalizeRuntimeName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return lower === 'claude_code' ? 'claude' : lower;
}

/**
 * Check whether the Claude, Gemini, and Codex CLI binaries are present, and whether
 * required API keys (OPENAI_API_KEY) are set.
 * Reads PRIMARY_RUNTIME, FORGE_DRAFTER_RUNTIME, and FORGE_AUDITOR_RUNTIME from env
 * to decide which binaries/keys are required. A missing needed binary or key is a fail;
 * a missing unneeded one is informational (ok: true, info: true).
 */
export function checkRuntimeBinaries(
  env: NodeJS.ProcessEnv,
  whichFn: (bin: string) => string | null,
): DoctorCheckResult[] {
  const primaryRuntime = (env.PRIMARY_RUNTIME ?? '').trim()
    ? normalizeRuntimeName(env.PRIMARY_RUNTIME!)
    : 'claude';
  const drafterRuntime = (env.FORGE_DRAFTER_RUNTIME ?? '').trim()
    ? normalizeRuntimeName(env.FORGE_DRAFTER_RUNTIME!)
    : null;
  const auditorRuntime = (env.FORGE_AUDITOR_RUNTIME ?? '').trim()
    ? normalizeRuntimeName(env.FORGE_AUDITOR_RUNTIME!)
    : null;

  const neededRuntimes = new Set<string>([
    primaryRuntime,
    ...(drafterRuntime ? [drafterRuntime] : []),
    ...(auditorRuntime ? [auditorRuntime] : []),
  ]);

  const claudeBin = (env.CLAUDE_BIN ?? '').trim() || 'claude';
  const geminiBin = (env.GEMINI_BIN ?? '').trim() || 'gemini';
  const codexBin = (env.CODEX_BIN ?? '').trim() || 'codex';
  const claudeNeeded = neededRuntimes.has('claude');
  const geminiNeeded = neededRuntimes.has('gemini');
  const codexNeeded = neededRuntimes.has('codex');
  const openaiNeeded = neededRuntimes.has('openai');

  const checks: DoctorCheckResult[] = [];

  const claudePath = whichFn(claudeBin);
  if (claudePath) {
    checks.push({ ok: true, label: `Claude CLI found: ${claudeBin}` });
  } else if (claudeNeeded) {
    checks.push({
      ok: false,
      label: `Claude CLI not found (looked for "${claudeBin}")`,
      hint: 'Install from https://docs.anthropic.com/en/docs/claude-code or set CLAUDE_BIN',
    });
  } else {
    checks.push({
      ok: true,
      info: true,
      label: `Claude CLI not found (looked for "${claudeBin}") — not needed for current runtime`,
    });
  }

  const geminiPath = whichFn(geminiBin);
  if (geminiPath) {
    checks.push({ ok: true, label: `Gemini CLI found: ${geminiBin}` });
  } else if (geminiNeeded) {
    checks.push({
      ok: false,
      label: `Gemini CLI not found (looked for "${geminiBin}")`,
      hint: 'Install the Gemini CLI or set GEMINI_BIN',
    });
  } else {
    checks.push({
      ok: true,
      info: true,
      label: `Gemini CLI not found (looked for "${geminiBin}") — not needed for current runtime`,
    });
  }

  const codexPath = whichFn(codexBin);
  if (codexPath) {
    checks.push({ ok: true, label: `Codex CLI found: ${codexBin}` });
  } else if (codexNeeded) {
    checks.push({
      ok: false,
      label: `Codex CLI not found (looked for "${codexBin}")`,
      hint: 'Install the Codex CLI or set CODEX_BIN',
    });
  } else {
    checks.push({
      ok: true,
      info: true,
      label: `Codex CLI not found (looked for "${codexBin}") — not needed for current runtime`,
    });
  }

  const openaiKey = (env.OPENAI_API_KEY ?? '').trim();
  if (openaiKey) {
    checks.push({ ok: true, label: 'OPENAI_API_KEY is set' });
  } else if (openaiNeeded) {
    checks.push({
      ok: false,
      label: 'OPENAI_API_KEY is not set',
      hint: 'Set OPENAI_API_KEY to your OpenAI API key',
    });
  } else {
    checks.push({
      ok: true,
      info: true,
      label: 'OPENAI_API_KEY is not set — not needed for current runtime',
    });
  }

  return checks;
}

export function checkRequiredForums(env: NodeJS.ProcessEnv): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];

  const cronEnabled = parseBooleanSetting(env, 'DISCOCLAW_CRON_ENABLED', true);
  if (cronEnabled.error) {
    checks.push({
      ok: false,
      label: 'DISCOCLAW_CRON_ENABLED must be "0"/"1" or "true"/"false"',
      hint: cronEnabled.error,
    });
  }
  if (cronEnabled.value) {
    const cronForum = (env.DISCOCLAW_CRON_FORUM ?? '').trim();
    if (!cronForum) {
      checks.push({
        ok: false,
        label: 'DISCOCLAW_CRON_FORUM is required when DISCOCLAW_CRON_ENABLED=1',
        hint: 'Set DISCOCLAW_CRON_FORUM to your agents forum channel ID (17-20 digits)',
      });
    } else if (!validateSnowflake(cronForum)) {
      checks.push({
        ok: false,
        label: 'DISCOCLAW_CRON_FORUM is not a valid snowflake',
        hint: 'Must be a 17-20 digit Discord channel ID',
      });
    } else {
      checks.push({ ok: true, label: 'DISCOCLAW_CRON_FORUM is set and valid' });
    }
  }

  const tasksEnabled = parseBooleanSetting(env, 'DISCOCLAW_TASKS_ENABLED', true);
  if (tasksEnabled.error) {
    checks.push({
      ok: false,
      label: 'DISCOCLAW_TASKS_ENABLED must be "0"/"1" or "true"/"false"',
      hint: tasksEnabled.error,
    });
  }
  if (tasksEnabled.value) {
    const tasksForum = (env.DISCOCLAW_TASKS_FORUM ?? '').trim();
    if (!tasksForum) {
      checks.push({
        ok: false,
        label: 'DISCOCLAW_TASKS_FORUM is required when DISCOCLAW_TASKS_ENABLED=1',
        hint: 'Set DISCOCLAW_TASKS_FORUM to your tasks forum channel ID (17-20 digits)',
      });
    } else if (!validateSnowflake(tasksForum)) {
      checks.push({
        ok: false,
        label: 'DISCOCLAW_TASKS_FORUM is not a valid snowflake',
        hint: 'Must be a 17-20 digit Discord channel ID',
      });
    } else {
      checks.push({ ok: true, label: 'DISCOCLAW_TASKS_FORUM is set and valid' });
    }
  }

  return checks;
}
