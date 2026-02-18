import type { DiscordActionResult, ActionContext } from './actions.js';
import { NO_MENTIONS } from './allowed-mentions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReactionPromptRequest = {
  type: 'reactionPrompt';
  /** Question text to display to the user. */
  question: string;
  /**
   * Ordered list of emoji choices. Each emoji will be added as a reaction.
   * The user's reaction resolves the prompt with the matching emoji.
   * 2–9 choices allowed.
   */
  choices: string[];
  /**
   * Seconds to wait before timing out. Defaults to 120. Max 300.
   */
  timeoutSeconds?: number;
};

export const REACTION_PROMPT_ACTION_TYPES = new Set<string>(['reactionPrompt']);

// ---------------------------------------------------------------------------
// Prompt store
// ---------------------------------------------------------------------------

type PendingPrompt = {
  choices: Set<string>;
  resolve: (emoji: string) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * In-memory store for pending reaction prompts.
 * Keyed by the bot's prompt message ID so the reaction handler can look up
 * and resolve the correct promise.
 */
const pendingPrompts = new Map<string, PendingPrompt>();

/**
 * Register a pending prompt, returning a Promise that resolves to the chosen
 * emoji when the user reacts (or rejects on timeout), plus a cancel function
 * for early cleanup (e.g. when adding a reaction fails).
 */
function registerPrompt(
  messageId: string,
  choices: string[],
  timeoutMs: number,
): { promise: Promise<string>; cancel: (reason: Error) => void } {
  let resolve!: (emoji: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout(() => {
    pendingPrompts.delete(messageId);
    reject(new Error(`Reaction prompt timed out after ${timeoutMs / 1000}s`));
  }, timeoutMs);

  pendingPrompts.set(messageId, { choices: new Set(choices), resolve, reject, timer });

  const cancel = (reason: Error) => {
    const pending = pendingPrompts.get(messageId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPrompts.delete(messageId);
      pending.reject(reason);
    }
  };

  return { promise, cancel };
}

/**
 * Called by the reaction handler when a user reacts to any message.
 * If the message ID matches a pending prompt and the emoji is a valid choice,
 * resolves and removes the pending entry.
 *
 * Returns true if the reaction was consumed by a prompt (caller should skip
 * the normal reaction-handler AI invocation).
 */
export function tryResolveReactionPrompt(messageId: string, emoji: string): boolean {
  const pending = pendingPrompts.get(messageId);
  if (!pending) return false;

  if (!pending.choices.has(emoji)) return false;

  clearTimeout(pending.timer);
  pendingPrompts.delete(messageId);
  pending.resolve(emoji);
  return true;
}

/**
 * Returns the number of currently pending prompts (useful for tests).
 */
export function pendingPromptCount(): number {
  return pendingPrompts.size;
}

/**
 * Clear all pending prompts — for use in tests only.
 */
export function _resetForTest(): void {
  for (const pending of pendingPrompts.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Reset for test'));
  }
  pendingPrompts.clear();
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 300;
const MIN_CHOICES = 2;
const MAX_CHOICES = 9;

export async function executeReactionPromptAction(
  action: ReactionPromptRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  // Validate question.
  if (typeof action.question !== 'string' || !action.question.trim()) {
    return { ok: false, error: 'reactionPrompt requires a non-empty question string' };
  }

  // Validate choices.
  if (!Array.isArray(action.choices) || action.choices.length < MIN_CHOICES || action.choices.length > MAX_CHOICES) {
    return { ok: false, error: `reactionPrompt requires ${MIN_CHOICES}–${MAX_CHOICES} choices` };
  }
  for (const c of action.choices) {
    if (typeof c !== 'string' || !c.trim()) {
      return { ok: false, error: 'reactionPrompt: each choice must be a non-empty emoji string' };
    }
  }

  // Resolve timeout.
  const rawTimeout = action.timeoutSeconds ?? DEFAULT_TIMEOUT_S;
  const timeoutS = Math.min(Math.max(1, rawTimeout), MAX_TIMEOUT_S);
  const timeoutMs = timeoutS * 1000;

  // Resolve the channel.
  const { guild, client, channelId } = ctx;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !('send' in channel)) {
    return { ok: false, error: `reactionPrompt: channel "${channelId}" not found or not a text channel` };
  }

  // Build the prompt message.
  const choiceList = action.choices.join('  ');
  const promptContent = `${action.question}\n\n${choiceList}`;

  // Send the prompt message.
  let promptMessage: { id: string; react: (emoji: string) => Promise<void> };
  try {
    promptMessage = await (channel as any).send({
      content: promptContent,
      allowedMentions: NO_MENTIONS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `reactionPrompt: failed to send prompt message: ${msg}` };
  }

  // Register the prompt *before* adding reactions so the reaction handler
  // can resolve it as soon as the first reaction arrives.
  const { promise: waitForReaction, cancel } = registerPrompt(promptMessage.id, action.choices, timeoutMs);
  // Suppress unhandled rejection if we bail out early (e.g. react failure).
  waitForReaction.catch(() => undefined);

  // Add reactions for each choice.
  for (const emoji of action.choices) {
    try {
      await promptMessage.react(emoji);
    } catch (err) {
      // Cancel the pending prompt so it doesn't leak on react failure.
      cancel(new Error(`reactionPrompt: failed to add reaction "${emoji}"`));
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `reactionPrompt: failed to add reaction "${emoji}": ${msg}` };
    }
  }

  // Block until the user reacts or the prompt times out.
  let chosen: string;
  try {
    chosen = await waitForReaction;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  return { ok: true, summary: `User chose: ${chosen}` };
}

// ---------------------------------------------------------------------------
// Prompt section (injected into the AI's system prompt)
// ---------------------------------------------------------------------------

export function reactionPromptSection(): string {
  return `### Reaction Prompts

**reactionPrompt** — Present a yes/no or multiple-choice question to the user via emoji reactions instead of requiring a typed reply. The bot sends a dedicated message with the question, adds each choice as a reaction, and waits for the user to react before continuing.

\`\`\`
<discord-action>{"type":"reactionPrompt","question":"Should I proceed?","choices":["✅","❌"],"timeoutSeconds":120}</discord-action>
\`\`\`

- \`question\` (required): The question text displayed to the user.
- \`choices\` (required): 2–9 emoji strings. Each will be added as a reaction to the prompt message.
- \`timeoutSeconds\` (optional): How long to wait for a response (1–300, default 120). If the user doesn't react in time, the action fails with a timeout error.

The action result contains the emoji the user chose (e.g. \`User chose: ✅\`), which is automatically sent back to you in the follow-up so you can act on the decision.

Use this for binary confirmations (✅/❌) or short option lists — not for open-ended text input.`;
}
