import type { RuntimeId } from './types.js';

/** Provider-agnostic model tier. */
export type ModelTier = 'fast' | 'capable' | 'deep';

const tiers = new Set<string>(['fast', 'capable', 'deep']);

/** Type guard for ModelTier. */
export function isModelTier(s: string): s is ModelTier {
  return tiers.has(s);
}

/**
 * Maps tier × runtime to a concrete model string.
 * Empty string = adapter-default sentinel (adapter uses its own defaultModel).
 */
const defaults: Record<string, Record<ModelTier, string>> = {
  claude_code: { fast: 'haiku', capable: 'sonnet', deep: 'claude-opus-4-6' },
  gemini: { fast: 'gemini-2.5-flash', capable: 'gemini-2.5-pro', deep: 'gemini-2.5-pro' },
  openai: { fast: 'gpt-5-mini', capable: 'gpt-5.4', deep: 'gpt-5.4-pro' },
  codex: { fast: 'gpt-5.1-codex-mini', capable: 'gpt-5.4', deep: 'gpt-5.4' },
};

function buildDefault(): Record<string, Record<ModelTier, string>> {
  return Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, { ...v }]));
}

let tierMap = buildDefault();

/**
 * Read env vars matching `DISCOCLAW_TIER_<RUNTIME>_<TIER>` and overlay them
 * onto the hardcoded defaults. Resets to defaults on each call so repeated
 * invocations are idempotent. If never called, defaults apply unchanged.
 *
 * Examples:
 *   DISCOCLAW_TIER_CLAUDE_CODE_FAST=sonnet
 *   DISCOCLAW_TIER_GEMINI_CAPABLE=gemini-2.5-flash
 */
export function initTierOverrides(env: Record<string, string | undefined>): void {
  tierMap = buildDefault();
  const PREFIX = 'DISCOCLAW_TIER_';
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || value === undefined) continue;
    const rest = key.slice(PREFIX.length);
    let tier: ModelTier;
    let runtimeUpper: string;
    if (rest.endsWith('_FAST')) {
      tier = 'fast';
      runtimeUpper = rest.slice(0, -'_FAST'.length);
    } else if (rest.endsWith('_CAPABLE')) {
      tier = 'capable';
      runtimeUpper = rest.slice(0, -'_CAPABLE'.length);
    } else if (rest.endsWith('_DEEP')) {
      tier = 'deep';
      runtimeUpper = rest.slice(0, -'_DEEP'.length);
    } else {
      continue;
    }
    const runtime = runtimeUpper.toLowerCase();
    if (!tierMap[runtime]) {
      tierMap[runtime] = { fast: '', capable: '', deep: '' };
    }
    tierMap[runtime][tier] = value;
  }
}

/**
 * Resolve a tier name or literal model string to a concrete model string.
 *
 * - Known tier name → look up in the built-in map for the given runtime.
 * - Anything else → pass through unchanged (supports `RUNTIME_MODEL=opus`
 *   or `RUNTIME_MODEL=claude-sonnet-4-5-20250929`).
 *
 * For runtimes not in the built-in map (`gemini`, `other`), tier inputs
 * resolve to `''` (adapter-default sentinel).
 */
export function resolveModel(tierOrModel: string, runtimeId: RuntimeId): string {
  if (!isModelTier(tierOrModel)) return tierOrModel;
  const runtimeTiers = tierMap[runtimeId];
  if (!runtimeTiers) return '';
  return runtimeTiers[tierOrModel];
}

/**
 * Maps tier × runtime to a reasoning-effort level.
 * Only runtimes / tiers that need an explicit effort are listed.
 */
const reasoningEffortDefaults: Record<string, Partial<Record<ModelTier, string>>> = {
  claude_code: { fast: 'low', capable: 'medium', deep: 'high' },
  codex: { fast: 'low', capable: 'high', deep: 'xhigh' },
};

/**
 * Resolve the reasoning-effort level for a given tier and runtime.
 *
 * Returns `undefined` when the input is not a recognised tier, the runtime
 * has no effort mapping, or the tier has no configured effort.
 */
export function resolveReasoningEffort(tier: string, runtimeId: RuntimeId): string | undefined {
  if (!isModelTier(tier)) return undefined;
  const runtimeEfforts = reasoningEffortDefaults[runtimeId];
  if (!runtimeEfforts) return undefined;
  return runtimeEfforts[tier];
}

/**
 * Reverse-lookup: find which runtime owns a concrete model string.
 *
 * Iterates the live tier map and returns the first runtime ID whose tier
 * values include `model`. Skips empty-string sentinel values so that
 * adapter-default entries never match. Returns `undefined` when no runtime
 * claims the model.
 */
export function findRuntimeForModel(model: string): string | undefined {
  for (const [runtimeId, tiers] of Object.entries(tierMap)) {
    for (const value of Object.values(tiers)) {
      if (value !== '' && value === model) return runtimeId;
    }
  }
  return undefined;
}
