/**
 * Pure helper functions for message batching.
 *
 * When multiple Discord messages arrive while an AI invocation is active for
 * the same session, these helpers support combining them into a single prompt
 * instead of processing each message sequentially.
 */

export type BatchedMessage = {
  /** Text content of the message. */
  content: string;
  /** Display name of the message author. Optional — used when formatting multi-author batches. */
  authorDisplayName?: string;
};

/**
 * Returns true when the message content looks like a bot command.
 *
 * Command messages start with `!` (after trimming whitespace) and should be
 * processed individually rather than batched with regular conversation messages.
 * This covers all built-in commands: !help, !stop, !cancel, !memory, !plan,
 * !forge, !models, !health, !status, !restart, !update, !confirm, etc.
 */
export function isCommandMessage(content: string): boolean {
  return content.trim().startsWith('!');
}

/**
 * Formats a list of pending messages into a single prompt string.
 *
 * - Empty array: returns an empty string.
 * - Single message: returns its content unchanged (no batching wrapper).
 * - Multiple messages: prefixes with a note about batching and lists each
 *   message in order, optionally showing the author's display name.
 */
export function formatBatchedMessages(messages: BatchedMessage[]): string {
  if (messages.length === 0) return '';
  if (messages.length === 1) return messages[0].content;

  const header = `[${messages.length} messages arrived while a previous response was in progress:]`;
  const items = messages.map((msg, i) => {
    const prefix = msg.authorDisplayName ? `${msg.authorDisplayName}: ` : '';
    return `${i + 1}. ${prefix}${msg.content}`;
  });

  return [header, '', ...items].join('\n');
}
