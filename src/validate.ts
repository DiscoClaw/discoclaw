/**
 * Shared validators for Discord tokens and snowflake IDs.
 * Used by scripts/doctor.ts and scripts/setup.ts.
 */

/** Token: 3 dot-separated base64url segments. */
export function validateDiscordToken(token: string): { valid: boolean; reason?: string } {
  if (!token) return { valid: false, reason: 'Token is empty' };

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: `Expected 3 dot-separated segments, got ${parts.length}` };
  }

  // Each segment must be non-empty base64url (A-Z, a-z, 0-9, -, _)
  const base64url = /^[A-Za-z0-9\-_]+$/;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i] || !base64url.test(parts[i])) {
      return { valid: false, reason: `Segment ${i + 1} contains invalid characters` };
    }
  }

  return { valid: true };
}

/**
 * Snowflake: 17-20 digit numeric string.
 *
 * This is intentionally stricter than the runtime `isSnowflake()` in
 * system-bootstrap.ts (which accepts 8+ digits for historical reasons).
 * Real Discord snowflakes are always 17-20 digits. This stricter check
 * is used in user-facing tools (doctor, setup wizard) to catch mistyped
 * IDs early. Runtime code keeps the looser pattern for compatibility.
 */
export function validateSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

/** Comma/space-separated snowflake list. Returns invalid IDs if any. */
export function validateSnowflakes(raw: string): { valid: boolean; invalidIds: string[] } {
  const ids = raw.split(/[,\s]+/).filter(Boolean);
  if (ids.length === 0) return { valid: false, invalidIds: [] };

  const invalidIds = ids.filter((id) => !validateSnowflake(id));
  return { valid: invalidIds.length === 0, invalidIds };
}
