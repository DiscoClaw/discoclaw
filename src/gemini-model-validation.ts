/**
 * Shared Gemini model-identifier validation.
 *
 * Every code path that interpolates a model value into a Gemini REST URL
 * (.../models/${model}:predict, :generateContent, :streamGenerateContent)
 * must call {@link validateGeminiModelId} **before** constructing the URL.
 *
 * Only alphanumerics, hyphens, dots, and underscores are legal in a Gemini
 * model path segment.  Anything else (slashes, colons, percent-encoding,
 * whitespace …) could alter the request URL.
 */

const GEMINI_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function validateGeminiModelId(
  model: string,
): { ok: true } | { ok: false; error: string } {
  if (GEMINI_MODEL_RE.test(model)) return { ok: true };
  return {
    ok: false,
    error: `invalid Gemini model identifier "${model}"`,
  };
}
