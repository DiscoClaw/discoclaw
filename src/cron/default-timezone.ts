/**
 * Returns the default timezone using a fallback chain:
 * 1. process.env.DEFAULT_TIMEZONE (if set and valid)
 * 2. Intl.DateTimeFormat().resolvedOptions().timeZone (system timezone)
 *
 * Invalid DEFAULT_TIMEZONE values are logged and skipped.
 */
export function getDefaultTimezone(): string {
  const envTz = process.env.DEFAULT_TIMEZONE;
  if (envTz) {
    try {
      // Validate by attempting to construct a formatter with this timezone.
      Intl.DateTimeFormat(undefined, { timeZone: envTz });
      return envTz;
    } catch {
      // Invalid IANA timezone in env var — fall through to system detection.
      // Log to stderr so the operator sees the misconfiguration.
      console.error(
        `[cron] DEFAULT_TIMEZONE="${envTz}" is not a valid IANA timezone; falling back to system timezone.`,
      );
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
