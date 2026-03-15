import { describe, expect, it } from 'vitest';
import { validateDiscordToken, validateSnowflake, validateSnowflakes } from '../src/validate.js';

/**
 * Doctor integration tests — verify that the validator functions used by
 * doctor.ts produce the expected results for typical doctor scenarios.
 *
 * We don't spawn the full doctor script (it has side effects: dotenv, process.exit).
 * Instead we test the validation logic it depends on.
 */

describe('doctor: token format validation', () => {
  it('accepts a well-formed bot token', () => {
    // Real tokens have this shape: base64(bot_id).timestamp.hmac
    const result = validateDiscordToken('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.G1x2y3.abcdefghijklmnopqrstuvwxyz1234567890AB');
    expect(result.valid).toBe(true);
  });

  it('rejects a token missing segments (common copy-paste error)', () => {
    const result = validateDiscordToken('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/1$/);
  });

  it('rejects an Application ID pasted as token (no dots)', () => {
    const result = validateDiscordToken('123456789012345678');
    expect(result.valid).toBe(false);
  });
});

describe('doctor: snowflake validation', () => {
  it('accepts a real-looking user ID', () => {
    expect(validateSnowflake('292029371241537536')).toBe(true);
  });

  it('rejects a non-numeric user ID', () => {
    expect(validateSnowflake('david#1234')).toBe(false);
  });

  it('rejects a short numeric string', () => {
    expect(validateSnowflake('12345')).toBe(false);
  });
});

describe('doctor: snowflake list validation', () => {
  it('validates a comma-separated allowlist', () => {
    const result = validateSnowflakes('292029371241537536,123456789012345678');
    expect(result.valid).toBe(true);
  });

  it('catches a non-numeric ID in a mixed list', () => {
    const result = validateSnowflakes('292029371241537536,badid,123456789012345678');
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toEqual(['badid']);
  });
});

