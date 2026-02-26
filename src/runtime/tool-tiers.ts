import { KNOWN_TOOLS } from '../config.js';

/** Three-level tool tier: basic (read-only), standard (+ Edit), full (all). */
export type ToolTier = 'basic' | 'standard' | 'full';

const validTiers = new Set<string>(['basic', 'standard', 'full']);

/**
 * Known tools allowed at the 'basic' tier (read-only, low-risk).
 */
const BASIC_ALLOWED: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
]);

/**
 * Known tools allowed at the 'standard' tier (basic + Edit).
 */
const STANDARD_ALLOWED: ReadonlySet<string> = new Set([
  ...BASIC_ALLOWED,
  'Edit',
]);

/**
 * Model-string patterns mapped to tool tiers. Evaluated in order — first match wins.
 */
const MODEL_PATTERNS: ReadonlyArray<{ test: (model: string) => boolean; tier: ToolTier }> = [
  // Claude
  { test: (m) => /haiku/i.test(m), tier: 'basic' },
  { test: (m) => /sonnet/i.test(m), tier: 'standard' },
  { test: (m) => /opus/i.test(m), tier: 'full' },
  // Gemini
  { test: (m) => /flash/i.test(m), tier: 'basic' },
  { test: (m) => /pro/i.test(m), tier: 'full' },
  // OpenAI
  { test: (m) => /gpt-4o-mini/i.test(m), tier: 'basic' },
  { test: (m) => /o\d+-mini/i.test(m), tier: 'basic' },
];

/** Per-model overrides from DISCOCLAW_TOOL_TIER_MAP env var. */
let toolTierOverrides: Map<string, ToolTier> = new Map();

/**
 * Parse DISCOCLAW_TOOL_TIER_MAP env var and populate overrides.
 * Format: "haiku=basic,sonnet=standard,opus=full"
 * Same init-once pattern as initTierOverrides in model-tiers.ts.
 */
export function initToolTierOverrides(env: Record<string, string | undefined>): void {
  toolTierOverrides = new Map();
  const raw = env.DISCOCLAW_TOOL_TIER_MAP;
  if (!raw) return;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const model = pair.slice(0, eq).trim().toLowerCase();
    const tier = pair.slice(eq + 1).trim();
    if (model && validTiers.has(tier)) {
      toolTierOverrides.set(model, tier as ToolTier);
    }
  }
}

/**
 * Infer the tool tier from a model string.
 * Checks env var overrides first, then pattern matching.
 * Defaults to 'full' for unknown models (fail-open for tool access).
 */
export function inferModelTier(model: string): ToolTier {
  if (!model) return 'full';
  const lower = model.toLowerCase();
  // Exact override match
  const exact = toolTierOverrides.get(lower);
  if (exact) return exact;
  // Substring override match
  for (const [key, tier] of toolTierOverrides) {
    if (lower.includes(key)) return tier;
  }
  for (const { test, tier } of MODEL_PATTERNS) {
    if (test(model)) return tier;
  }
  return 'full';
}

/**
 * Filter tools based on tool tier.
 *
 * - `full` — all tools pass through unchanged.
 * - `standard` — drops Bash and Write from known tools; unknown tools pass through.
 * - `basic` — drops Bash, Write, and Edit from known tools; unknown tools pass through.
 *
 * Tools not in KNOWN_TOOLS always pass through (preserving custom tool behavior).
 */
export function filterToolsByTier(
  tools: string[],
  tier: ToolTier,
): { tools: string[]; dropped: string[] } {
  if (tier === 'full') return { tools: [...tools], dropped: [] };

  const allowedSet = tier === 'standard' ? STANDARD_ALLOWED : BASIC_ALLOWED;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const tool of tools) {
    if (!KNOWN_TOOLS.has(tool) || allowedSet.has(tool)) {
      kept.push(tool);
    } else {
      dropped.push(tool);
    }
  }
  return { tools: kept, dropped };
}
