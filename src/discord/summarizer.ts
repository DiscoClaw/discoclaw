import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeAdapter } from '../runtime/types.js';

export type ConversationSummary = {
  summary: string;
  updatedAt: number;
  turnsSinceUpdate?: number;
};

function asConversationSummary(value: unknown): ConversationSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as {
    summary?: unknown;
    updatedAt?: unknown;
    turnsSinceUpdate?: unknown;
  };
  if (typeof candidate.summary !== 'string' || typeof candidate.updatedAt !== 'number') return null;
  if (candidate.turnsSinceUpdate !== undefined && typeof candidate.turnsSinceUpdate !== 'number') return null;
  return candidate as ConversationSummary;
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
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
