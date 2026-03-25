import { describe, expect, it } from 'vitest';
import { getMigrationHint } from './migration-hints.js';

describe('getMigrationHint', () => {
  it('returns a renamed hint for "gemini"', () => {
    const hint = getMigrationHint('gemini');
    expect(hint).toEqual({
      kind: 'renamed',
      oldName: 'gemini',
      newName: 'gemini-api',
      message: 'Runtime "gemini" was renamed to "gemini-api". Update your .env: PRIMARY_RUNTIME=gemini-api',
    });
  });

  it('returns a removed hint for "gemini-cli"', () => {
    const hint = getMigrationHint('gemini-cli');
    expect(hint).toEqual({
      kind: 'removed',
      oldName: 'gemini-cli',
      message: 'gemini-cli was removed due to TOS risk. Use PRIMARY_RUNTIME=gemini-api with GEMINI_API_KEY instead.',
    });
  });

  it('is case-insensitive', () => {
    expect(getMigrationHint('Gemini')).not.toBeNull();
    expect(getMigrationHint('GEMINI-CLI')).not.toBeNull();
  });

  it('trims whitespace', () => {
    expect(getMigrationHint('  gemini  ')).not.toBeNull();
  });

  it('returns null for a completely unknown name', () => {
    expect(getMigrationHint('nonexistent-runtime')).toBeNull();
  });

  it('returns null for valid runtime names (no hint needed)', () => {
    expect(getMigrationHint('claude-cli')).toBeNull();
    expect(getMigrationHint('openai')).toBeNull();
    expect(getMigrationHint('gemini-api')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getMigrationHint('')).toBeNull();
    expect(getMigrationHint('   ')).toBeNull();
  });
});
