import { resolveModel } from '../runtime/model-tiers.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { ParsedCronDef } from './types.js';
import { getDefaultTimezone } from './default-timezone.js';

/**
 * Deterministic parser for bot-formatted starter messages produced by
 * `buildStarterContent` in `src/discord/actions-crons.ts`.
 *
 * Expected format:
 *   **Schedule:** `<schedule>` (<timezone>)
 *   **Channel:** #<channel>
 *   **Input:** <input-mode>
 *   [optional ```bash block```]
 *
 *   <prompt text>
 *
 * Returns null if any required field is missing — non-bot-formatted
 * messages silently fall through to AI.
 */
export function parseStarterContent(text: string): ParsedCronDef | null {
  // Extract schedule and timezone from: **Schedule:** `<schedule>` (<timezone>)
  const scheduleMatch = text.match(/\*\*Schedule:\*\*\s*`([^`]+)`\s*\(([^)]+)\)/);
  if (!scheduleMatch) return null;
  const schedule = scheduleMatch[1].trim();
  const timezone = scheduleMatch[2].trim();
  if (!schedule || !timezone) return null;

  // Extract channel from: **Channel:** #<channel>
  const channelMatch = text.match(/\*\*Channel:\*\*\s*#(\S+)/);
  if (!channelMatch) return null;
  const channel = channelMatch[1].trim();
  if (!channel) return null;

  // The prompt is everything after the blank-line separator following the metadata block.
  // The metadata block ends after the **Input:** line (and optional ```bash``` block).
  // Split on the first blank line that follows the metadata lines.
  const lines = text.split('\n');
  let blankLineIdx = -1;
  let pastMetadata = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track when we've passed the metadata lines (lines starting with ** or code fences)
    if (line.startsWith('**') || line.startsWith('```')) {
      pastMetadata = true;
      continue;
    }
    // After metadata, find the first blank line
    if (pastMetadata && line.trim() === '') {
      blankLineIdx = i;
      break;
    }
  }
  if (blankLineIdx === -1) return null;

  const prompt = lines.slice(blankLineIdx + 1).join('\n').trim();
  if (!prompt) return null;

  return {
    triggerType: 'schedule',
    schedule,
    timezone,
    channel,
    prompt,
  };
}

function buildSystemPrompt(): string {
  const defaultTz = getDefaultTimezone();
  return `You are a cron definition parser. Extract a cron schedule from a natural-language task description.

Return ONLY valid JSON with these fields:
- schedule: 5-field cron expression (minute hour day-of-month month day-of-week)
- timezone: IANA timezone string (default "${defaultTz}" if not specified)
- channel: target Discord channel name (without #) or ID. If the user says "post to #general", channel is "general".
- prompt: the instruction text the bot should follow at each execution (rephrase as a direct instruction)

Rules:
- Use standard 5-field cron (no seconds). Examples: "0 7 * * 1-5" = weekdays at 7am, "*/5 * * * *" = every 5 minutes, "0 9 * * 1" = Mondays at 9am.
- Day-of-week: 0=Sunday, 1=Monday, ..., 6=Saturday. Range "1-5" = weekdays.
- If the user says "every minute", use "* * * * *".
- If no timezone is mentioned, default to "${defaultTz}".
- If no target channel is mentioned, set channel to "general".
- The prompt field should capture what the bot should do/say, not the scheduling part.

Return ONLY the JSON object, no markdown fences, no explanation.`;
}

export async function parseCronDefinition(
  text: string,
  runtime: RuntimeAdapter,
  opts?: { model?: string; cwd?: string; timeoutMs?: number },
): Promise<ParsedCronDef | null> {
  const prompt = `${buildSystemPrompt()}\n\nUser definition:\n${text}`;
  let finalText = '';
  let deltaText = '';

  for await (const evt of runtime.invoke({
    prompt,
    model: resolveModel(opts?.model ?? 'fast', runtime.id),
    cwd: opts?.cwd ?? process.cwd(),
    timeoutMs: opts?.timeoutMs ?? 30_000,
    tools: [],
  })) {
    if (evt.type === 'text_final') {
      finalText = evt.text;
    } else if (evt.type === 'text_delta') {
      deltaText += evt.text;
    } else if (evt.type === 'error') {
      return null;
    }
  }

  const output = finalText || deltaText;

  // Strip markdown fences if present.
  const cleaned = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (
      typeof parsed.schedule !== 'string' ||
      typeof parsed.timezone !== 'string' ||
      typeof parsed.channel !== 'string' ||
      typeof parsed.prompt !== 'string'
    ) {
      return null;
    }
    return {
      triggerType: 'schedule',
      schedule: parsed.schedule.trim(),
      timezone: parsed.timezone.trim() || getDefaultTimezone(),
      channel: parsed.channel.replace(/^#/, '').trim(),
      prompt: parsed.prompt.trim(),
    };
  } catch {
    return null;
  }
}
