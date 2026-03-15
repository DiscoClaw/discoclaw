/**
 * Voice-context data sanitizer — strips identifiers, codes, and hashes
 * from text before it reaches the voice AI model.
 *
 * Defense in depth: VOICE_STYLE_INSTRUCTION tells the model not to read
 * IDs aloud. This sanitizer removes them from the data so there's nothing
 * to leak even if the style instruction is bypassed.
 */

/**
 * Replacement rules applied in order. More specific patterns (parenthesized
 * task IDs) precede generic ones (bare backtick IDs) to avoid partial matches.
 */
const RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // (`ws-1064`) — parenthesized backtick task IDs (handleTaskShow output)
  { pattern: / ?\(`[a-zA-Z]+-\d+`\)/g, replacement: '' },

  // `ws-1064` — bare backtick task IDs (handleTaskList output)
  { pattern: /`[a-zA-Z]+-\d+` ?/g, replacement: '' },

  // (#485) — parenthesized issue/PR references
  { pattern: /\(#\d+\)/g, replacement: '' },

  // 0de0834 — standalone commit hashes (7-40 hex chars, must contain a digit)
  { pattern: /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, replacement: '' },

  // 1234567890123456789 — Discord snowflake IDs (17-20 digit numbers)
  { pattern: /\b\d{17,20}\b/g, replacement: '' },
];

const DISCORD_ACTION_BLOCK_RE = /<discord-action>[\s\S]*?<\/discord-action>/gi;
const VOICE_TOOLISH_LINE_RE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:query_[a-z0-9_]+\b|task_(?:list|show|create|update|close|sync)\b|plan_(?:list|show|create|approve|close|run)\b|forge_(?:create|resume|status|cancel)\b|memory_(?:show|remember|forget)\b|cron_(?:list|show|create|update|delete|run|pause|resume)\b|model_(?:show|set)\b|!+(?:plan|forge|memory|restart|models|voice|stop)\b|<discord-action>)/i;
const TERMINAL_PUNCT_RE = /[.!?]["')\]]?$/;
const FALLBACK_SPOKEN_REPLY = 'I need a moment to check that.';

export type VoiceSpeechGuardResult = {
  text: string;
  removedToolLines: number;
  trimmedDanglingTail: boolean;
};

/**
 * Strip identifiers and machine-readable codes from text intended for voice output.
 *
 * Targets task IDs (`ws-1064`), commit hashes, Discord snowflakes, and
 * PR/issue references. Collapses resulting whitespace artifacts.
 *
 * @returns The sanitized text, or empty string if input is empty/whitespace.
 */
export function sanitizeForVoice(text: string): string {
  if (!text) return '';

  let result = text;
  for (const { pattern, replacement } of RULES) {
    result = result.replace(pattern, replacement);
  }

  // Collapse multi-space runs left by removals; preserve newlines.
  return result.replace(/ {2,}/g, ' ').trim();
}

/**
 * Prepare runtime output for speech playback.
 *
 * Guardrail 1: strip non-speech tool/query command lines and action blocks.
 * Guardrail 2: run identifier sanitizer as a fallback.
 * Guardrail 3: trim dangling trailing fragments from truncated output.
 */
export function sanitizeVoiceReplyForSpeech(text: string): VoiceSpeechGuardResult {
  if (!text) {
    return { text: '', removedToolLines: 0, trimmedDanglingTail: false };
  }

  const withoutActionBlocks = text.replace(DISCORD_ACTION_BLOCK_RE, '').trim();
  let removedToolLines = 0;
  const keptLines = withoutActionBlocks
    .split('\n')
    .filter((line) => {
      const isToolish = VOICE_TOOLISH_LINE_RE.test(line.trim());
      if (isToolish) removedToolLines += 1;
      return !isToolish;
    });

  let cleaned = sanitizeForVoice(keptLines.join('\n'));
  let trimmedDanglingTail = false;

  if (cleaned && !TERMINAL_PUNCT_RE.test(cleaned)) {
    const lastTerminalIndex = Math.max(
      cleaned.lastIndexOf('.'),
      cleaned.lastIndexOf('!'),
      cleaned.lastIndexOf('?'),
    );
    if (lastTerminalIndex >= 0 && lastTerminalIndex < cleaned.length - 1) {
      cleaned = cleaned.slice(0, lastTerminalIndex + 1).trim();
      trimmedDanglingTail = true;
    }
  }

  if (!cleaned && removedToolLines > 0) {
    return {
      text: FALLBACK_SPOKEN_REPLY,
      removedToolLines,
      trimmedDanglingTail: false,
    };
  }

  return {
    text: cleaned,
    removedToolLines,
    trimmedDanglingTail,
  };
}
