import type { RuntimeId } from './types.js';

export type RuntimePathCanonicalName =
  | 'claude-api'
  | 'claude-cli'
  | 'codex-cli'
  | 'gemini-api'
  | 'openai'
  | 'openrouter';

export type RuntimePathPlacement =
  | 'startup:PRIMARY_RUNTIME'
  | 'startup:DISCOCLAW_FAST_RUNTIME'
  | 'startup:FORGE_DRAFTER_RUNTIME'
  | 'startup:FORGE_AUDITOR_RUNTIME'
  | 'live:chat'
  | 'live:voice'
  | 'runtime-overrides:fastRuntime'
  | 'runtime-overrides:voiceRuntime';

export type RuntimeSecretEnvKey =
  | 'ANTHROPIC_API_KEY'
  | 'GEMINI_API_KEY'
  | 'OPENAI_API_KEY'
  | 'OPENROUTER_API_KEY';

export type RuntimePathPersistence = 'env' | 'memory' | 'runtime-overrides.json';

export type RuntimePathResetBehavior =
  | '!models reset fast'
  | '!models reset voice'
  | 'edit-env-and-restart'
  | 'restart-or-explicit-runtime-switch';

export type RuntimePathDefinition = {
  canonicalName: RuntimePathCanonicalName;
  acceptedAliases: readonly string[];
  registryKeys: readonly string[];
  runtimeId: RuntimeId;
  providerSecretEnvKey?: RuntimeSecretEnvKey;
};

export type RuntimePathPlacementDefinition = {
  placement: RuntimePathPlacement;
  persistence: RuntimePathPersistence;
  resetBehavior: RuntimePathResetBehavior;
  supportedRuntimeNames: readonly RuntimePathCanonicalName[];
};

const RUNTIME_PATH_DEFINITIONS: Readonly<Record<RuntimePathCanonicalName, RuntimePathDefinition>> = {
  'claude-api': {
    canonicalName: 'claude-api',
    acceptedAliases: ['claude-api', 'anthropic'],
    registryKeys: ['claude-api'],
    runtimeId: 'claude_api',
    providerSecretEnvKey: 'ANTHROPIC_API_KEY',
  },
  'claude-cli': {
    canonicalName: 'claude-cli',
    acceptedAliases: ['claude-cli', 'claude', 'claude_code'],
    registryKeys: ['claude-cli'],
    runtimeId: 'claude_code',
  },
  'codex-cli': {
    canonicalName: 'codex-cli',
    acceptedAliases: ['codex-cli', 'codex'],
    registryKeys: ['codex-cli'],
    runtimeId: 'codex',
  },
  'gemini-api': {
    canonicalName: 'gemini-api',
    acceptedAliases: ['gemini-api'],
    registryKeys: ['gemini-api'],
    runtimeId: 'gemini',
    providerSecretEnvKey: 'GEMINI_API_KEY',
  },
  openai: {
    canonicalName: 'openai',
    acceptedAliases: ['openai'],
    registryKeys: ['openai'],
    runtimeId: 'openai',
    providerSecretEnvKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    canonicalName: 'openrouter',
    acceptedAliases: ['openrouter'],
    registryKeys: ['openrouter'],
    runtimeId: 'openrouter',
    providerSecretEnvKey: 'OPENROUTER_API_KEY',
  },
};

const STARTUP_RUNTIME_NAMES: readonly RuntimePathCanonicalName[] = [
  'claude-cli',
  'codex-cli',
  'gemini-api',
  'openai',
  'openrouter',
];

const VOICE_RUNTIME_NAMES: readonly RuntimePathCanonicalName[] = [
  ...STARTUP_RUNTIME_NAMES,
  'claude-api',
];

const RUNTIME_PATH_PLACEMENTS: Readonly<Record<RuntimePathPlacement, RuntimePathPlacementDefinition>> = {
  'startup:PRIMARY_RUNTIME': {
    placement: 'startup:PRIMARY_RUNTIME',
    persistence: 'env',
    resetBehavior: 'edit-env-and-restart',
    supportedRuntimeNames: STARTUP_RUNTIME_NAMES,
  },
  'startup:DISCOCLAW_FAST_RUNTIME': {
    placement: 'startup:DISCOCLAW_FAST_RUNTIME',
    persistence: 'env',
    resetBehavior: 'edit-env-and-restart',
    supportedRuntimeNames: STARTUP_RUNTIME_NAMES,
  },
  'startup:FORGE_DRAFTER_RUNTIME': {
    placement: 'startup:FORGE_DRAFTER_RUNTIME',
    persistence: 'env',
    resetBehavior: 'edit-env-and-restart',
    supportedRuntimeNames: STARTUP_RUNTIME_NAMES,
  },
  'startup:FORGE_AUDITOR_RUNTIME': {
    placement: 'startup:FORGE_AUDITOR_RUNTIME',
    persistence: 'env',
    resetBehavior: 'edit-env-and-restart',
    supportedRuntimeNames: STARTUP_RUNTIME_NAMES,
  },
  'live:chat': {
    placement: 'live:chat',
    persistence: 'memory',
    resetBehavior: 'restart-or-explicit-runtime-switch',
    supportedRuntimeNames: STARTUP_RUNTIME_NAMES,
  },
  'live:voice': {
    placement: 'live:voice',
    persistence: 'runtime-overrides.json',
    resetBehavior: '!models reset voice',
    supportedRuntimeNames: VOICE_RUNTIME_NAMES,
  },
  'runtime-overrides:fastRuntime': {
    placement: 'runtime-overrides:fastRuntime',
    persistence: 'runtime-overrides.json',
    resetBehavior: '!models reset fast',
    supportedRuntimeNames: STARTUP_RUNTIME_NAMES,
  },
  'runtime-overrides:voiceRuntime': {
    placement: 'runtime-overrides:voiceRuntime',
    persistence: 'runtime-overrides.json',
    resetBehavior: '!models reset voice',
    supportedRuntimeNames: VOICE_RUNTIME_NAMES,
  },
};

const ALIAS_TO_CANONICAL = new Map<string, RuntimePathCanonicalName>();
for (const definition of Object.values(RUNTIME_PATH_DEFINITIONS)) {
  for (const alias of definition.acceptedAliases) {
    ALIAS_TO_CANONICAL.set(alias, definition.canonicalName);
  }
}

function normalizeRuntimeInput(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

export function canonicalizeRuntimePathName(raw: string | undefined): RuntimePathCanonicalName | undefined {
  const normalized = normalizeRuntimeInput(raw);
  if (!normalized) return undefined;
  return ALIAS_TO_CANONICAL.get(normalized);
}

export function getRuntimePathDefinition(
  runtimeName: RuntimePathCanonicalName | string | undefined,
): RuntimePathDefinition | undefined {
  const canonicalName = canonicalizeRuntimePathName(runtimeName);
  return canonicalName ? RUNTIME_PATH_DEFINITIONS[canonicalName] : undefined;
}

export function getRuntimePlacementDefinition(
  placement: RuntimePathPlacement,
): RuntimePathPlacementDefinition {
  return RUNTIME_PATH_PLACEMENTS[placement];
}

export function isRuntimeNameSupportedInPlacement(
  runtimeName: RuntimePathCanonicalName | string | undefined,
  placement: RuntimePathPlacement,
): boolean {
  const canonicalName = canonicalizeRuntimePathName(runtimeName);
  if (!canonicalName) return false;
  return getRuntimePlacementDefinition(placement).supportedRuntimeNames.includes(canonicalName);
}

export function parseRuntimeNameForPlacement(
  raw: string | undefined,
  placement: RuntimePathPlacement,
): RuntimePathCanonicalName | undefined {
  const canonicalName = canonicalizeRuntimePathName(raw);
  if (!canonicalName) return undefined;
  return isRuntimeNameSupportedInPlacement(canonicalName, placement) ? canonicalName : undefined;
}

export function getRuntimeProviderSecretEnvKey(
  runtimeName: RuntimePathCanonicalName | string | undefined,
): RuntimeSecretEnvKey | undefined {
  return getRuntimePathDefinition(runtimeName)?.providerSecretEnvKey;
}

export function listCanonicalRuntimeNames(
  placement?: RuntimePathPlacement,
): RuntimePathCanonicalName[] {
  if (!placement) {
    return Object.keys(RUNTIME_PATH_DEFINITIONS) as RuntimePathCanonicalName[];
  }
  return [...getRuntimePlacementDefinition(placement).supportedRuntimeNames];
}
