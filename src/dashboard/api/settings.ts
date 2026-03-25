import type { DashboardDeps } from '../../cli/dashboard.js';
import type { InspectOptions } from '../../health/config-doctor.js';
import { ALLOWED_SETTING_KEYS, SETTING_DEFINITIONS, type SettingDefinition } from '../settings-keys.js';

export type SettingValue = {
  key: string;
  label: string;
  type: string;
  default: boolean | number;
  value: string | undefined;
};

export type SettingsCategories = Record<string, SettingValue[]>;

export type DashboardSettingsGetResponse = {
  ok: true;
  categories: SettingsCategories;
};

export type DashboardSettingsPostResponse = {
  ok: true;
  message: string;
  categories: SettingsCategories;
};

function buildCategories(
  env: NodeJS.ProcessEnv,
  overrideKey?: string,
  overrideValue?: string,
): SettingsCategories {
  const grouped: SettingsCategories = {};
  for (const def of SETTING_DEFINITIONS) {
    if (!grouped[def.category]) grouped[def.category] = [];
    grouped[def.category].push({
      key: def.key,
      label: def.label,
      type: def.type,
      default: def.default,
      value: def.key === overrideKey ? overrideValue : env[def.key],
    });
  }
  return grouped;
}

export function buildSettingsGetResponse(
  env: NodeJS.ProcessEnv,
): DashboardSettingsGetResponse {
  return { ok: true, categories: buildCategories(env) };
}

export function validateSettingUpdate(
  key: string,
  value: string,
): { key: string; value: string; def: SettingDefinition } {
  if (!key) throw new Error('Setting key is required.');
  if (!ALLOWED_SETTING_KEYS.has(key)) throw new Error(`Unknown setting key: ${key}`);
  if (value === '') throw new Error('Setting value is required.');

  const def = SETTING_DEFINITIONS.find((d) => d.key === key);
  if (def?.type === 'boolean' && value !== 'true' && value !== 'false' && value !== '1' && value !== '0') {
    throw new Error(`Setting value must be "true"/"false" or "1"/"0" for ${key}.`);
  }
  if (def?.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Setting value must be a non-negative number for ${key}.`);
    }
  }

  return { key, value, def: def! };
}

export async function buildSettingsPostResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: Pick<DashboardDeps, 'loadDoctorContext' | 'updateEnvKey'>,
  key: string,
  value: string,
): Promise<DashboardSettingsPostResponse> {
  const { key: validatedKey, value: validatedValue } = validateSettingUpdate(key, value);

  const ctx = await deps.loadDoctorContext(inspectOpts);
  await deps.updateEnvKey(ctx.configPaths.env, validatedKey, validatedValue);

  return {
    ok: true,
    message: `Updated ${validatedKey}. Restart the service to apply.`,
    categories: buildCategories(inspectOpts.env, validatedKey, validatedValue),
  };
}
