/**
 * Hardcoded style directive injected into every voice AI invocation.
 *
 * TTS latency compounds with response length — shorter means faster
 * time-to-first-word. Listeners can't skim audio; verbosity is punishing.
 *
 * This is separate from the user-configurable DISCOCLAW_VOICE_SYSTEM_PROMPT
 * and does not affect chat/text behavior.
 */
export const VOICE_STYLE_INSTRUCTION =
  'Telegraphic style: answer first, explain after only if needed. ' +
  'No markdown (no bullets, headers, bold, code blocks). ' +
  'No preambles ("Great question", "Sure", "Of course"). ' +
  'No filler. Short sentences. One idea per sentence.';
