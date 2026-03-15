import { describe, expect, it, vi, afterEach } from 'vitest';
import { getDefaultTimezone } from './default-timezone.js';

describe('getDefaultTimezone', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns DEFAULT_TIMEZONE when set to a valid IANA timezone', () => {
    vi.stubEnv('DEFAULT_TIMEZONE', 'America/New_York');
    expect(getDefaultTimezone()).toBe('America/New_York');
  });

  it('falls back to system timezone when env var is not set', () => {
    vi.stubEnv('DEFAULT_TIMEZONE', '');
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(getDefaultTimezone()).toBe(systemTz);
  });

  it('falls back to system timezone and logs error for invalid DEFAULT_TIMEZONE', () => {
    vi.stubEnv('DEFAULT_TIMEZONE', 'NotATimezone');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(getDefaultTimezone()).toBe(systemTz);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('NotATimezone'),
    );

    consoleSpy.mockRestore();
  });

  it('always returns a non-empty string', () => {
    vi.stubEnv('DEFAULT_TIMEZONE', '');
    const result = getDefaultTimezone();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
