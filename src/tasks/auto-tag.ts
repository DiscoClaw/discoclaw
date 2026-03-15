import type { TaskModelResolver, TaskRuntimeAdapter } from './runtime-types.js';

export type AutoTagOptions = {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  modelResolver?: TaskModelResolver;
};

/**
 * Use an AI model to classify a task into 1-3 forum tags from the available
 * set. Returns an array of valid tag names (silently drops unknown ones).
 */
export async function autoTagTask(
  runtime: TaskRuntimeAdapter,
  title: string,
  description: string,
  availableTags: string[],
  opts?: AutoTagOptions,
): Promise<string[]> {
  if (availableTags.length === 0) return [];

  const tagList = availableTags.join(', ');
  const prompt =
    `Classify this task into 1-3 tags from the following list. ` +
    `Reply with ONLY comma-separated tag names, nothing else.\n\n` +
    `Available tags: ${tagList}\n\n` +
    `Title: ${title}\n` +
    (description ? `Description: ${description.slice(0, 500)}\n` : '');

  let finalText = '';
  let deltaText = '';

  const modelResolver = opts?.modelResolver ?? ((model: string) => model);

  for await (const evt of runtime.invoke({
    prompt,
    model: modelResolver(opts?.model ?? 'fast', runtime.id),
    cwd: opts?.cwd ?? '.',
    timeoutMs: opts?.timeoutMs ?? 15_000,
    tools: [],
  })) {
    if (evt.type === 'text_final' && typeof evt.text === 'string') {
      finalText = evt.text;
    } else if (evt.type === 'text_delta' && typeof evt.text === 'string') {
      deltaText += evt.text;
    } else if (evt.type === 'error') {
      return [];
    }
  }

  const output = (finalText || deltaText).trim();
  if (!output) return [];

  const tagSet = new Set(availableTags.map((tag) => tag.toLowerCase()));
  const candidates = output.split(/[,\n]+/).map((tag) => tag.trim()).filter(Boolean);

  const result: string[] = [];
  for (const candidate of candidates) {
    // Find the original-cased tag name.
    const match = availableTags.find((tag) => tag.toLowerCase() === candidate.toLowerCase());
    if (match && tagSet.has(candidate.toLowerCase())) {
      result.push(match);
    }
    if (result.length >= 3) break;
  }

  return result;
}
