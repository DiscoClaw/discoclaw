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
