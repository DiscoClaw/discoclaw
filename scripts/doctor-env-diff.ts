/**
 * Pure helpers for comparing .env against .env.example.
 * Used by doctor.ts check 6b (env var coverage).
 */

const ENV_VAR_RE = /^\s*(?:export\s+)?#?\s*([A-Z][A-Z0-9_]*)=/;

/**
 * Extract env var names from a dotenv-style file.
 * Matches lines like `KEY=...`, `#KEY=...` (commented defaults),
 * and `export KEY=...` / `export #KEY=...` (shell-style exports).
 * Ignores comment-only lines (# text without =), blank lines,
 * and malformed lines (no `=`, lowercase-only keys).
 */
export function extractEnvVarNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const line of content.split('\n')) {
    const match = line.match(ENV_VAR_RE);
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Compare template vars against user vars.
 * Returns only the names in template that are absent from user.
 */
export function missingEnvVars(templateContent: string, userContent: string): string[] {
  const templateVars = extractEnvVarNames(templateContent);
  const userVars = extractEnvVarNames(userContent);
  return [...templateVars].filter((v) => !userVars.has(v));
}
