import type { RuntimeId } from './types.js';

/** Provider-agnostic model tier. */
export type ModelTier = 'fast' | 'capable';

const tiers = new Set<string>(['fast', 'capable']);

/** Type guard for ModelTier. */
export function isModelTier(s: string): s is ModelTier {
  return tiers.has(s);
}

/**
 * Maps tier × runtime to a concrete model string.
 * Empty string = adapter-default sentinel (adapter uses its own defaultModel).
 */
const defaults: Record<string, Record<ModelTier, string>> = {
  claude_code: { fast: 'haiku', capable: 'sonnet' },
  gemini: { fast: 'gemini-2.5-flash', capable: 'gemini-2.5-pro' },
  openai: { fast: '', capable: '' },
  codex: { fast: '', capable: '' },
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
    } else {
      continue;
    }
    const runtime = runtimeUpper.toLowerCase();
    if (!tierMap[runtime]) {
      tierMap[runtime] = { fast: '', capable: '' };
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
