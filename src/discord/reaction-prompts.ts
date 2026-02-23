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
   * Kept for backwards compatibility with AI-generated actions — ignored.
   */
  timeoutSeconds?: number;
};

export const REACTION_PROMPT_ACTION_TYPES = new Set<string>(['reactionPrompt']);

type ReactionPromptMessage = {
  id: string;
  react: (emoji: string) => Promise<void>;
};

type SendableChannel = {
  send(payload: { content: string; allowedMentions?: unknown }): Promise<ReactionPromptMessage>;
};

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return !!channel && typeof channel === 'object' && 'send' in channel &&
    typeof (channel as { send?: unknown }).send === 'function';
}

// ---------------------------------------------------------------------------
// Prompt store
// ---------------------------------------------------------------------------

type PendingPrompt = {
  question: string;
  choices: Set<string>;
};

/**
 * In-memory store for pending reaction prompts.
 * Keyed by the bot's prompt message ID so the reaction handler can look up
 * and match the correct record.
 */
const pendingPrompts = new Map<string, PendingPrompt>();

/**
 * Register a pending prompt in the store.
 */
function registerPrompt(messageId: string, question: string, choices: string[]): void {
  pendingPrompts.set(messageId, { question, choices: new Set(choices) });
}

/**
 * Called by the reaction handler when a user reacts to any message.
 * If the message ID matches a pending prompt and the emoji is a valid choice,
 * returns the matched record data (and deletes it from the map).
 *
 * Returns { question, chosenEmoji } if matched, null otherwise.
 * The reaction handler should continue into its normal AI invocation flow
 * with a prompt that conveys the user's choice.
 */
export function tryResolveReactionPrompt(
  messageId: string,
  emoji: string,
): { question: string; chosenEmoji: string } | null {
  const pending = pendingPrompts.get(messageId);
  if (!pending) return null;

  if (!pending.choices.has(emoji)) return null;

  pendingPrompts.delete(messageId);
  return { question: pending.question, chosenEmoji: emoji };
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
  pendingPrompts.clear();
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

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

  // Resolve the channel.
  const { guild, channelId } = ctx;
  const channel = guild.channels.cache.get(channelId);
  if (!isSendableChannel(channel)) {
    return { ok: false, error: `reactionPrompt: channel "${channelId}" not found or not a text channel` };
  }

  // Send the prompt message (question text only — no emoji in the body).
  let promptMessage: { id: string; react: (emoji: string) => Promise<void> };
  try {
    promptMessage = await channel.send({
      content: action.question,
      allowedMentions: NO_MENTIONS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `reactionPrompt: failed to send prompt message: ${msg}` };
  }

  // Register the prompt *before* adding reactions so the reaction handler
  // can match it as soon as the first reaction arrives.
  registerPrompt(promptMessage.id, action.question, action.choices);

  // Add reactions for each choice.
  for (const emoji of action.choices) {
    try {
      await promptMessage.react(emoji);
    } catch (err) {
      // Clean up the pending record so it doesn't leak on react failure.
      pendingPrompts.delete(promptMessage.id);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `reactionPrompt: failed to add reaction "${emoji}": ${msg}` };
    }
  }

  return { ok: true, summary: 'Prompt sent — awaiting user reaction' };
}

// ---------------------------------------------------------------------------
// Prompt section (injected into the AI's system prompt)
// ---------------------------------------------------------------------------

export function reactionPromptSection(): string {
  return `### Reaction Prompts

**reactionPrompt** — Present a yes/no or multiple-choice question to the user via emoji reactions instead of requiring a typed reply. The bot sends a dedicated message with the question text, adds each choice as a reaction, and returns immediately. When the user reacts, their choice triggers a follow-up AI invocation automatically with a prompt that conveys the user's decision.

\`\`\`
<discord-action>{"type":"reactionPrompt","question":"Should I proceed?","choices":["✅","❌"]}</discord-action>
\`\`\`

- \`question\` (required): The question text displayed to the user.
- \`choices\` (required): 2–9 emoji strings. Each will be added as a reaction to the prompt message.
- \`timeoutSeconds\` (optional): Accepted for compatibility but not used — the prompt waits indefinitely and the user's reaction triggers a follow-up automatically.

The action returns immediately with a confirmation that the prompt was sent. When the user reacts with a valid choice, a follow-up invocation is triggered automatically so you can act on the decision.

Use this for binary confirmations (✅/❌) or short option lists — not for open-ended text input.`;
}
