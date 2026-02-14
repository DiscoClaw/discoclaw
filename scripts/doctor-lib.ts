import { validateSnowflake } from '../src/validate.js';

export type DoctorCheckResult = {
  ok: boolean;
  label: string;
  hint?: string;
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
        hint: 'Set DISCOCLAW_CRON_FORUM to your cron forum channel ID (17-20 digits)',
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

  const beadsEnabled = parseBooleanSetting(env, 'DISCOCLAW_BEADS_ENABLED', true);
  if (beadsEnabled.error) {
    checks.push({
      ok: false,
      label: 'DISCOCLAW_BEADS_ENABLED must be "0"/"1" or "true"/"false"',
      hint: beadsEnabled.error,
    });
  }
  if (beadsEnabled.value) {
    const beadsForum = (env.DISCOCLAW_BEADS_FORUM ?? '').trim();
    if (!beadsForum) {
      checks.push({
        ok: false,
        label: 'DISCOCLAW_BEADS_FORUM is required when DISCOCLAW_BEADS_ENABLED=1',
        hint: 'Set DISCOCLAW_BEADS_FORUM to your beads forum channel ID (17-20 digits)',
      });
    } else if (!validateSnowflake(beadsForum)) {
      checks.push({
        ok: false,
        label: 'DISCOCLAW_BEADS_FORUM is not a valid snowflake',
        hint: 'Must be a 17-20 digit Discord channel ID',
      });
    } else {
      checks.push({ ok: true, label: 'DISCOCLAW_BEADS_FORUM is set and valid' });
    }
  }

  return checks;
}
