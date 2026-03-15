import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { ContinuationCapsule } from './capsule.js';
import { normalizeContinuationCapsule, renderContinuationCapsule } from './capsule.js';

export type ConversationSummary = {
  summary: string;
  updatedAt: number;
  regeneratedAt?: number;
  turnsSinceUpdate?: number;
  continuationCapsule?: ContinuationCapsule;
};

function formatSummaryAge(elapsedMs: number): string {
  const clampedMs = Math.max(0, elapsedMs);
  const totalMinutes = Math.floor(clampedMs / 60_000);
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

function formatRecencyAnnotation(
  regeneratedAt?: number,
  turnsSinceUpdate?: number,
  now = Date.now(),
): string {
  if (typeof regeneratedAt !== 'number') return '';
  const newerTurns = typeof turnsSinceUpdate === 'number' && turnsSinceUpdate >= 0 ? turnsSinceUpdate : 0;
  return ` Last regenerated ${formatSummaryAge(now - regeneratedAt)} ago; ${newerTurns} newer turn${newerTurns === 1 ? '' : 's'} since then.`;
}

function asConversationSummary(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as {
    summary?: unknown;
    updatedAt?: unknown;
    regeneratedAt?: unknown;
    turnsSinceUpdate?: unknown;
    continuationCapsule?: unknown;
  };
  if (typeof candidate.summary !== 'string' || typeof candidate.updatedAt !== 'number') return null;
  if (candidate.regeneratedAt !== undefined && typeof candidate.regeneratedAt !== 'number') return null;
  if (candidate.turnsSinceUpdate !== undefined && typeof candidate.turnsSinceUpdate !== 'number') return null;

  const summary: ConversationSummary = {
    summary: candidate.summary,
    updatedAt: candidate.updatedAt,
    ...(candidate.regeneratedAt !== undefined ? { regeneratedAt: candidate.regeneratedAt } : {}),
    ...(candidate.turnsSinceUpdate !== undefined ? { turnsSinceUpdate: candidate.turnsSinceUpdate } : {}),
  };
  const continuationCapsule = asContinuationCapsule(candidate.continuationCapsule);
  if (continuationCapsule) {
    summary.continuationCapsule = continuationCapsule;
  }
  return summary;
}

function asContinuationCapsule(value: unknown): ContinuationCapsule | undefined {
  return normalizeContinuationCapsule(value) ?? undefined;
}

function safeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

export async function loadSummary(
  dir: string,
  sessionKey: string,
): Promise<ConversationSummary | null> {
  const filePath = path.join(dir, `${safeSessionKey(sessionKey)}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return asConversationSummary(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // Malformed file or other read error — treat as missing.
    return null;
  }
}

export async function saveSummary(
  dir: string,
  sessionKey: string,
  data: ConversationSummary,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeSessionKey(sessionKey)}.json`);
  const tmp = `${filePath}.tmp.${process.pid}`;
  const normalizedCapsule = asContinuationCapsule(data.continuationCapsule);
  const payload: ConversationSummary = {
    ...data,
    ...(normalizedCapsule ? { continuationCapsule: normalizedCapsule } : {}),
  };
  if (!normalizedCapsule) {
    delete payload.continuationCapsule;
  }
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

export async function archiveSummary(
  archiveDir: string,
  sessionKey: string,
  channelName: string,
  summary: string,
): Promise<void> {
  try {
    await fs.mkdir(archiveDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(archiveDir, `${date}.jsonl`);
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionKey,
      channelName,
      summary,
    });
    await fs.appendFile(filePath, entry + '\n', 'utf8');
  } catch (err) {
    // Archive failures must never block summary saves — log and swallow.
    console.error('[archiveSummary] failed:', err);
  }
}

export function buildConversationMemorySection(
  summary: string,
  metadata?: { turnsSinceUpdate?: number; regeneratedAt?: number; now?: number },
  continuationCapsule?: ContinuationCapsule,
): string {
  const renderedSummary = summary.trim().length > 0 ? summary : 'No rolling summary yet.';
  const lines = [
    'Conversation memory:',
    `Rolling summary only; treat this as background context.${formatRecencyAnnotation(metadata?.regeneratedAt, metadata?.turnsSinceUpdate, metadata?.now)} If it conflicts with recent conversation, reply context, tool output, or the current user message, trust the fresher evidence.`,
    renderedSummary,
    'If your active task, current focus, next step, or blocker changes, emit an updated <continuation-capsule> block in your response.',
  ];
  if (continuationCapsule) {
    lines.push('Continuation capsule (verbatim, persisted outside the rolling summary):');
    lines.push(renderContinuationCapsule(continuationCapsule));
  }
  return lines.join('\n');
}

export type GenerateSummaryOpts = {
  previousSummary: string | null;
  recentExchange: string;
  model: string;
  cwd: string;
  maxChars: number;
  timeoutMs: number;
  taskStatusContext?: string;
};

export function estimateSummaryTokens(summary: string): number {
  const chars = summary.length;
  return Math.ceil(chars / 4);
}

export type RecompressSummaryOpts = {
  summary: string;
  model: string;
  cwd: string;
  thresholdTokens: number;
  targetTokens: number;
  timeoutMs: number;
  taskStatusContext?: string;
};

const SUMMARIZE_PROMPT_TEMPLATE = `You are a conversation summarizer. Update the running summary below with the new exchange.

Rules:
- Keep the summary under {maxChars} characters.
- Drop filler; keep decisions, preferences, current focus, and key facts.
- Treat the new exchange as fresher than the current summary. When they conflict, replace stale details with the newer state instead of carrying both forward.
- If the new exchange shows something was fixed, merged, deployed, reset, completed, or otherwise resolved, remove stale "pending" wording from the summary.
- Do not duplicate continuation capsule content into the summary body; capsule state is stored separately.
- Write in third person, present tense.
- Output ONLY the updated summary text, nothing else.
{taskStatusRule}
{previousSection}
{taskStatusSection}New exchange:
{recentExchange}

Updated summary:`;

const RECOMPRESS_PROMPT_TEMPLATE = `You are compressing a rolling conversation summary that exceeded its token budget.

Rules:
- Reduce the summary to at most {targetTokens} tokens (rough estimate: 1 token ~= 4 chars).
- Drop stale details that are no longer relevant.
- Collapse repeated references into a single concise mention.
- Preserve active project state and unresolved threads.
- Keep important decisions, preferences, and current focus.
- Do not duplicate continuation capsule content into the summary body; capsule state is stored separately.
- Write in third person, present tense.
- Output ONLY the recompressed summary text, nothing else.
{taskStatusRule}
Token context:
- Current estimated tokens: {beforeTokens}
- Recompress threshold: {thresholdTokens}

Current summary:
{summary}

{taskStatusSection}Recompressed summary:`;

function taskStatusPromptParts(taskStatusContext?: string): { taskStatusRule: string; taskStatusSection: string } {
  if (taskStatusContext === undefined) {
    return { taskStatusRule: '', taskStatusSection: '' };
  }

  return {
    taskStatusRule:
      '- A task status snapshot is provided below. Update the summary to reflect the current status of any referenced tasks. Tasks listed under "Recently closed" are now done — correct any stale open references to them. Tasks not present as active and not listed as recently closed are likely closed — remove or correct stale open-task references. If the snapshot notes it is truncated, only reconcile tasks explicitly listed.',
    taskStatusSection: `Current task statuses:\n${taskStatusContext}\n\n`,
  };
}

export async function generateSummary(
  runtime: RuntimeAdapter,
  opts: GenerateSummaryOpts,
): Promise<string> {
  try {
    const previousSection = opts.previousSummary
      ? `Current summary:\n${opts.previousSummary}\n`
      : 'Current summary:\n(none)\n';

    const { taskStatusRule, taskStatusSection } = taskStatusPromptParts(opts.taskStatusContext);

    const prompt = SUMMARIZE_PROMPT_TEMPLATE
      .replace('{maxChars}', String(opts.maxChars))
      .replace('{taskStatusRule}', taskStatusRule)
      .replace('{previousSection}', previousSection)
      .replace('{taskStatusSection}', taskStatusSection)
      .replace('{recentExchange}', opts.recentExchange);

    let finalText = '';
    let deltaText = '';

    for await (const evt of runtime.invoke({
      prompt,
      model: opts.model,
      cwd: opts.cwd,
      tools: [],
      timeoutMs: opts.timeoutMs,
    })) {
      if (evt.type === 'text_final') {
        finalText = evt.text;
      } else if (evt.type === 'text_delta') {
        deltaText += evt.text;
      } else if (evt.type === 'error') {
        return opts.previousSummary ?? '';
      }
    }

    const result = (finalText || deltaText).trim();
    return result || (opts.previousSummary ?? '');
  } catch {
    return opts.previousSummary ?? '';
  }
}

export async function recompressSummary(
  runtime: RuntimeAdapter,
  opts: RecompressSummaryOpts,
): Promise<string> {
  const beforeTokens = estimateSummaryTokens(opts.summary);
  if (beforeTokens <= opts.thresholdTokens) return opts.summary;

  try {
    const { taskStatusRule, taskStatusSection } = taskStatusPromptParts(opts.taskStatusContext);
    const prompt = RECOMPRESS_PROMPT_TEMPLATE
      .replace('{targetTokens}', String(opts.targetTokens))
      .replace('{beforeTokens}', String(beforeTokens))
      .replace('{thresholdTokens}', String(opts.thresholdTokens))
      .replace('{summary}', opts.summary)
      .replace('{taskStatusRule}', taskStatusRule)
      .replace('{taskStatusSection}', taskStatusSection);

    let finalText = '';
    let deltaText = '';

    for await (const evt of runtime.invoke({
      prompt,
      model: opts.model,
      cwd: opts.cwd,
      tools: [],
      timeoutMs: opts.timeoutMs,
    })) {
      if (evt.type === 'text_final') {
        finalText = evt.text;
      } else if (evt.type === 'text_delta') {
        deltaText += evt.text;
      } else if (evt.type === 'error') {
        return opts.summary;
      }
    }

    const result = (finalText || deltaText).trim();
    if (!result) return opts.summary;

    const afterTokens = estimateSummaryTokens(result);
    console.info(
      `[recompressSummary] token estimate before=${beforeTokens} after=${afterTokens} threshold=${opts.thresholdTokens} target=${opts.targetTokens}`,
    );
    return result;
  } catch {
    return opts.summary;
  }
}
