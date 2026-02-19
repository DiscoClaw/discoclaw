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
const tierMap: Record<string, Record<ModelTier, string>> = {
  claude_code: { fast: 'haiku', capable: 'opus' },
  gemini: { fast: 'gemini-2.5-flash', capable: 'gemini-2.5-pro' },
  openai: { fast: '', capable: '' },
  codex: { fast: '', capable: '' },
};

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
