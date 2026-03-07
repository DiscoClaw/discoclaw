import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PendingReactionPrompt = {
  question: string;
  choices: Set<string>;
};

type PersistedPendingReactionPrompt = {
  messageId: string;
  question: string;
  choices: string[];
};

export type ResolvedReactionPrompt = {
  question: string;
  chosenEmoji: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_FILE_NAME = 'reaction-prompts.json';

export function resolveReactionPromptStoreFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredDataDir = (env.DISCOCLAW_DATA_DIR ?? '').trim();
  const dataDir = configuredDataDir || DEFAULT_DATA_DIR;
  return path.join(dataDir, 'discord', STORE_FILE_NAME);
}

function asPersistedPendingReactionPrompt(value: unknown): PersistedPendingReactionPrompt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { messageId?: unknown; question?: unknown; choices?: unknown };
  if (typeof candidate.messageId !== 'string' || !candidate.messageId.trim()) return null;
  if (typeof candidate.question !== 'string' || !candidate.question.trim()) return null;
  if (!Array.isArray(candidate.choices) || candidate.choices.length === 0) return null;
  if (!candidate.choices.every((choice) => typeof choice === 'string' && choice.trim())) return null;

  return {
    messageId: candidate.messageId,
    question: candidate.question,
    choices: candidate.choices,
  };
}

function loadPendingPromptsFromDisk(filePath: string): Map<string, PendingReactionPrompt> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();

    const next = new Map<string, PendingReactionPrompt>();
    for (const entry of parsed) {
      const prompt = asPersistedPendingReactionPrompt(entry);
      if (!prompt) continue;
      next.set(prompt.messageId, {
        question: prompt.question,
        choices: new Set(prompt.choices),
      });
    }
    return next;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new Map();
    return new Map();
  }
}

export class ReactionPromptStore {
  private readonly pendingPrompts = new Map<string, PendingReactionPrompt>();

  constructor(private readonly filePath: string = resolveReactionPromptStoreFilePath()) {
    this.hydrateFromDisk();
  }

  registerPrompt(messageId: string, question: string, choices: string[]): void {
    const previous = this.pendingPrompts.get(messageId);
    this.pendingPrompts.set(messageId, { question, choices: new Set(choices) });
    try {
      this.persistToDisk();
    } catch (err) {
      if (previous) {
        this.pendingPrompts.set(messageId, previous);
      } else {
        this.pendingPrompts.delete(messageId);
      }
      throw err;
    }
  }

  tryResolvePrompt(messageId: string, emoji: string): ResolvedReactionPrompt | null {
    const pending = this.pendingPrompts.get(messageId);
    if (!pending) return null;
    if (!pending.choices.has(emoji)) return null;

    this.pendingPrompts.delete(messageId);
    try {
      this.persistToDisk();
    } catch (err) {
      this.pendingPrompts.set(messageId, pending);
      throw err;
    }

    return { question: pending.question, chosenEmoji: emoji };
  }

  removePrompt(messageId: string): void {
    const pending = this.pendingPrompts.get(messageId);
    if (!pending) return;

    this.pendingPrompts.delete(messageId);
    try {
      this.persistToDisk();
    } catch (err) {
      this.pendingPrompts.set(messageId, pending);
      throw err;
    }
  }

  pendingCount(): number {
    return this.pendingPrompts.size;
  }

  resetMemory(): void {
    this.pendingPrompts.clear();
  }

  hydrateFromDisk(): void {
    const hydrated = loadPendingPromptsFromDisk(this.filePath);
    this.pendingPrompts.clear();
    for (const [messageId, prompt] of hydrated.entries()) {
      this.pendingPrompts.set(messageId, prompt);
    }
  }

  private persistToDisk(): void {
    const serialized: PersistedPendingReactionPrompt[] = Array.from(this.pendingPrompts.entries()).map(
      ([messageId, prompt]) => ({
        messageId,
        question: prompt.question,
        choices: Array.from(prompt.choices),
      }),
    );

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(serialized, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup only.
      }
      throw err;
    }
  }
}
