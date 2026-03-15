import { describe, expect, it } from 'vitest';
import { extractEnvVarNames, missingEnvVars } from './doctor-env-diff.js';

describe('extractEnvVarNames', () => {
  it('extracts uncommented vars', () => {
    const result = extractEnvVarNames('DISCORD_TOKEN=abc\nDISCORD_ALLOW_USER_IDS=123');
    expect(result).toEqual(new Set(['DISCORD_TOKEN', 'DISCORD_ALLOW_USER_IDS']));
  });

  it('extracts commented vars with #KEY=value', () => {
    const result = extractEnvVarNames('#RUNTIME_MODEL=opus');
    expect(result).toEqual(new Set(['RUNTIME_MODEL']));
  });

  it('extracts commented vars with # KEY=value (space after #)', () => {
    const result = extractEnvVarNames('# RUNTIME_MODEL=opus');
    expect(result).toEqual(new Set(['RUNTIME_MODEL']));
  });

  it('handles export KEY=value', () => {
    const result = extractEnvVarNames('export DISCORD_TOKEN=abc');
    expect(result).toEqual(new Set(['DISCORD_TOKEN']));
  });

  it('handles export #KEY=value', () => {
    const result = extractEnvVarNames('export #RUNTIME_MODEL=opus');
    expect(result).toEqual(new Set(['RUNTIME_MODEL']));
  });

  it('ignores pure comments (no =)', () => {
    const result = extractEnvVarNames('# This is a note\n# Another comment');
    expect(result).toEqual(new Set());
  });

  it('ignores blank lines', () => {
    const result = extractEnvVarNames('\n\n  \n');
    expect(result).toEqual(new Set());
  });

  it('ignores malformed lines (no =)', () => {
    const result = extractEnvVarNames('JUST_A_KEY');
    expect(result).toEqual(new Set());
  });

  it('ignores lowercase-only keys', () => {
    const result = extractEnvVarNames('lowercase_key=value');
    expect(result).toEqual(new Set());
  });

  it('ignores mixed-case keys', () => {
    const result = extractEnvVarNames('Discord_Token=abc');
    expect(result).toEqual(new Set());
  });

  it('ignores keys starting with a digit', () => {
    const result = extractEnvVarNames('2FA_SECRET=value');
    expect(result).toEqual(new Set());
  });
});

describe('missingEnvVars', () => {
  it('returns vars in template but not in user file', () => {
    const template = 'DISCORD_TOKEN=\nDISCORD_GUILD_ID=\n#RUNTIME_MODEL=opus';
    const user = 'DISCORD_TOKEN=abc';
    expect(missingEnvVars(template, user)).toEqual(['DISCORD_GUILD_ID', 'RUNTIME_MODEL']);
  });

  it('returns empty array when user has all template vars', () => {
    const template = 'DISCORD_TOKEN=\nDISCORD_GUILD_ID=';
    const user = 'DISCORD_TOKEN=abc\nDISCORD_GUILD_ID=123';
    expect(missingEnvVars(template, user)).toEqual([]);
  });

  it('handles empty template content', () => {
    expect(missingEnvVars('', 'DISCORD_TOKEN=abc')).toEqual([]);
  });

  it('handles empty user content', () => {
    expect(missingEnvVars('DISCORD_TOKEN=\nDISCORD_GUILD_ID=', '')).toEqual([
      'DISCORD_TOKEN',
      'DISCORD_GUILD_ID',
    ]);
  });
});
