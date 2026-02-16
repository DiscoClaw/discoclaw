import { resolveModel } from '../runtime/model-tiers.js';
import type { ModelTier } from '../runtime/model-tiers.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { CadenceTag } from './run-stats.js';

export type AutoTagOptions = {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Purpose classification (AI)
// ---------------------------------------------------------------------------

export async function autoTagCron(
  runtime: RuntimeAdapter,
  name: string,
  prompt: string,
  availableTags: string[],
  opts?: AutoTagOptions,
): Promise<string[]> {
  if (availableTags.length === 0) return [];

  const tagList = availableTags.join(', ');
  const classifyPrompt =
    `Classify this scheduled task into 1-3 tags from the following list. ` +
    `Reply with ONLY comma-separated tag names, nothing else.\n\n` +
    `Available tags: ${tagList}\n\n` +
    `Rules:\n` +
    `- reporting: generates reports, summaries, digests\n` +
    `- monitoring: health checks, alerts, status polling\n` +
    `- cleanup: deletes old data, archives, purges\n` +
    `- notifications: sends reminders, alerts, announcements\n` +
    `- sync: data synchronization, imports, exports\n` +
    `- backup: backups, snapshots, data preservation\n` +
    `- maintenance: updates, migrations, housekeeping\n` +
    `- analytics: metrics, tracking, dashboards\n\n` +
    `Job name: ${name}\n` +
    `Instruction: ${prompt.slice(0, 500)}`;

  let finalText = '';
  let deltaText = '';

  for await (const evt of runtime.invoke({
    prompt: classifyPrompt,
    model: resolveModel(opts?.model ?? 'fast', runtime.id),
    cwd: opts?.cwd ?? '.',
    timeoutMs: opts?.timeoutMs ?? 15_000,
    tools: [],
  })) {
    if (evt.type === 'text_final') {
      finalText = evt.text;
    } else if (evt.type === 'text_delta') {
      deltaText += evt.text;
    } else if (evt.type === 'error') {
      return [];
    }
  }

  const output = (finalText || deltaText).trim();
  if (!output) return [];

  const tagSet = new Set(availableTags.map((t) => t.toLowerCase()));
  const candidates = output.split(/[,\n]+/).map((t) => t.trim()).filter(Boolean);

  const result: string[] = [];
  for (const candidate of candidates) {
    const match = availableTags.find((t) => t.toLowerCase() === candidate.toLowerCase());
    if (match && tagSet.has(candidate.toLowerCase())) {
      result.push(match);
    }
    if (result.length >= 3) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Model tier classification
// ---------------------------------------------------------------------------

/**
 * Classify whether a cron job needs capable-tier or can run on fast.
 *
 * Two-step logic:
 * 1. Cadence default: frequent/hourly (>1x/day) → fast immediately (cost optimization).
 * 2. AI classification for daily+ crons: ask fast-tier model to decide.
 */
export async function classifyCronModel(
  runtime: RuntimeAdapter,
  name: string,
  prompt: string,
  cadence: CadenceTag,
  opts?: AutoTagOptions,
): Promise<ModelTier> {
  // High-frequency crons default to fast — skip AI call for cost.
  if (cadence === 'frequent' || cadence === 'hourly') {
    return 'fast';
  }

  const classifyPrompt =
    `Does this scheduled task require advanced reasoning (complex analysis, ` +
    `multi-step planning, nuanced writing) or can it be handled with basic ` +
    `capabilities (simple lookups, templated responses, data formatting)?\n\n` +
    `Reply with ONLY one word: "capable" or "fast"\n\n` +
    `Job name: ${name}\n` +
    `Instruction: ${prompt.slice(0, 500)}`;

  let finalText = '';
  let deltaText = '';

  for await (const evt of runtime.invoke({
    prompt: classifyPrompt,
    model: resolveModel(opts?.model ?? 'fast', runtime.id),
    cwd: opts?.cwd ?? '.',
    timeoutMs: opts?.timeoutMs ?? 15_000,
    tools: [],
  })) {
    if (evt.type === 'text_final') {
      finalText = evt.text;
    } else if (evt.type === 'text_delta') {
      deltaText += evt.text;
    } else if (evt.type === 'error') {
      return 'fast';
    }
  }

  const output = (finalText || deltaText).trim().toLowerCase();
  return output === 'capable' ? 'capable' : 'fast';
}
