import fs from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeAdapter } from '../runtime/types.js';

export type ConversationSummary = {
  summary: string;
  updatedAt: number;
  turnsSinceUpdate?: number;
};

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
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'summary' in parsed &&
      typeof (parsed as any).summary === 'string'
    ) {
      return parsed as ConversationSummary;
    }
    return null;
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

export type GenerateSummaryOpts = {
  previousSummary: string | null;
  recentExchange: string;
  model: string;
  cwd: string;
  maxChars: number;
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

export async function generateSummary(
  runtime: RuntimeAdapter,
  opts: GenerateSummaryOpts,
): Promise<string> {
  try {
    const previousSection = opts.previousSummary
      ? `Current summary:\n${opts.previousSummary}\n`
      : 'Current summary:\n(none)\n';

    const taskStatusRule = opts.taskStatusContext !== undefined
      ? '- A task status snapshot is provided below. Update the summary to reflect the current status of any referenced tasks. Tasks not present in the snapshot are closed — remove or correct stale references to them. If the snapshot notes it is truncated, only reconcile tasks explicitly listed.'
      : '';

    const taskStatusSection = opts.taskStatusContext !== undefined
      ? `Current task statuses:\n${opts.taskStatusContext}\n\n`
      : '';

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
