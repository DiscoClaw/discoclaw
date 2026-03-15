import { describe, expect, it } from 'vitest';
import { validateDiscordToken, validateSnowflake, validateSnowflakes } from './validate.js';

describe('validateDiscordToken', () => {
  it('accepts a valid 3-segment base64url token', () => {
    expect(validateDiscordToken('MTIzNDU2Nzg5.abc123.def456-_')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const r = validateDiscordToken('');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });

  it('rejects token with wrong segment count (2 segments)', () => {
    const r = validateDiscordToken('abc.def');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/3 dot-separated/);
  });

  it('rejects token with wrong segment count (4 segments)', () => {
    const r = validateDiscordToken('a.b.c.d');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/3 dot-separated/);
  });

  it('rejects token with no dots', () => {
    const r = validateDiscordToken('nodots');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/1$/);
  });

  it('rejects token with invalid base64 chars', () => {
    const r = validateDiscordToken('abc.d e f.ghi');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/invalid characters/);
  });

  it('rejects token with empty segment', () => {
    const r = validateDiscordToken('abc..ghi');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/invalid characters/);
  });

  it('accepts token with hyphens and underscores (base64url)', () => {
    expect(validateDiscordToken('a-b.c_d.e-f')).toEqual({ valid: true });
  });
});

describe('validateSnowflake', () => {
  it('accepts 17-digit snowflake', () => {
    expect(validateSnowflake('12345678901234567')).toBe(true);
  });

  it('accepts 18-digit snowflake', () => {
    expect(validateSnowflake('123456789012345678')).toBe(true);
  });

  it('accepts 19-digit snowflake', () => {
    expect(validateSnowflake('1234567890123456789')).toBe(true);
  });

  it('accepts 20-digit snowflake', () => {
    expect(validateSnowflake('12345678901234567890')).toBe(true);
  });

  it('rejects 16-digit string (too short)', () => {
    expect(validateSnowflake('1234567890123456')).toBe(false);
  });

  it('rejects 21-digit string (too long)', () => {
    expect(validateSnowflake('123456789012345678901')).toBe(false);
  });

  it('rejects string with letters', () => {
    expect(validateSnowflake('1234567890123456a')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateSnowflake('')).toBe(false);
  });

  it('rejects string with spaces', () => {
    expect(validateSnowflake('1234567890 1234567')).toBe(false);
  });
});

describe('validateSnowflakes', () => {
  it('validates a single valid snowflake', () => {
    expect(validateSnowflakes('12345678901234567')).toEqual({ valid: true, invalidIds: [] });
  });

  it('validates comma-separated snowflakes', () => {
    expect(validateSnowflakes('12345678901234567,98765432109876543')).toEqual({ valid: true, invalidIds: [] });
  });

  it('validates space-separated snowflakes', () => {
    expect(validateSnowflakes('12345678901234567 98765432109876543')).toEqual({ valid: true, invalidIds: [] });
  });

  it('validates mixed comma and space separation', () => {
    expect(validateSnowflakes('12345678901234567, 98765432109876543')).toEqual({ valid: true, invalidIds: [] });
  });

  it('returns invalid IDs in a mixed list', () => {
    const r = validateSnowflakes('12345678901234567,abc,98765432109876543,short');
    expect(r.valid).toBe(false);
    expect(r.invalidIds).toEqual(['abc', 'short']);
  });

  it('returns invalid when empty string is given', () => {
    expect(validateSnowflakes('')).toEqual({ valid: false, invalidIds: [] });
  });

  it('returns invalid when only whitespace/commas', () => {
    expect(validateSnowflakes(', , ')).toEqual({ valid: false, invalidIds: [] });
  });
});
