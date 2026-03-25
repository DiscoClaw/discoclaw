/**
 * Migration hints for stale PRIMARY_RUNTIME values.
 *
 * When a configured runtime name is not found in the registry, these maps
 * provide actionable guidance telling the user exactly what to change in
 * their .env file.
 */

/** Runtimes that were renamed — value is the new canonical name. */
const KNOWN_RENAMES: ReadonlyMap<string, string> = new Map([
  ['gemini', 'gemini-api'],
]);

/** Runtimes that were removed entirely — value is a human-readable reason. */
const KNOWN_REMOVALS: ReadonlyMap<string, string> = new Map([
  ['gemini-cli', 'gemini-cli was removed due to TOS risk. Use PRIMARY_RUNTIME=gemini-api with GEMINI_API_KEY instead.'],
]);

export type MigrationHint =
  | { kind: 'renamed'; oldName: string; newName: string; message: string }
  | { kind: 'removed'; oldName: string; message: string }
  | null;

/**
 * Look up a migration hint for a runtime name that failed registry lookup.
 *
 * Returns `null` when the name is not in either map (i.e. it is simply
 * unknown rather than a stale/removed name).
 */
export function getMigrationHint(runtimeName: string): MigrationHint {
  const normalized = runtimeName.trim().toLowerCase();
  if (!normalized) return null;

  const renamed = KNOWN_RENAMES.get(normalized);
  if (renamed) {
    return {
      kind: 'renamed',
      oldName: normalized,
      newName: renamed,
      message: `Runtime "${normalized}" was renamed to "${renamed}". Update your .env: PRIMARY_RUNTIME=${renamed}`,
    };
  }

  const removal = KNOWN_REMOVALS.get(normalized);
  if (removal) {
    return {
      kind: 'removed',
      oldName: normalized,
      message: removal,
    };
  }

  return null;
}
