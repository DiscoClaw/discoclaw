import { describe, it, expect } from 'vitest';
import { parseHelpCommand, handleHelpCommand } from './help-command.js';

describe('parseHelpCommand', () => {
  it('matches !help exactly', () => {
    expect(parseHelpCommand('!help')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseHelpCommand('!HELP')).toBe(true);
    expect(parseHelpCommand('!Help')).toBe(true);
  });

  it('handles surrounding whitespace', () => {
    expect(parseHelpCommand('  !help  ')).toBe(true);
  });

  it('rejects commands that start with !help but have extra content', () => {
    expect(parseHelpCommand('!helping')).toBeNull();
    expect(parseHelpCommand('!helper')).toBeNull();
    expect(parseHelpCommand('!help me')).toBeNull();
    expect(parseHelpCommand('!help foo')).toBeNull();
  });

  it('returns null for unrelated messages', () => {
    expect(parseHelpCommand('hello')).toBeNull();
    expect(parseHelpCommand('!restart')).toBeNull();
    expect(parseHelpCommand('!health')).toBeNull();
    expect(parseHelpCommand('')).toBeNull();
  });
});

describe('handleHelpCommand', () => {
  it('returns a string listing all commands', () => {
    const result = handleHelpCommand();
    expect(typeof result).toBe('string');
    expect(result).toContain('!forge');
    expect(result).toContain('!plan');
    expect(result).toContain('!memory');
    expect(result).toContain('!models');
    expect(result).toContain('!health');
    expect(result).toContain('!update');
    expect(result).toContain('!restart');
    expect(result).toContain('!stop');
    expect(result).toContain('!help');
  });

  it('mentions help subcommands for commands that have them', () => {
    const result = handleHelpCommand();
    expect(result).toContain('!forge help');
    expect(result).toContain('!plan help');
    expect(result).toContain('!models help');
    expect(result).toContain('!update help');
    expect(result).toContain('!restart help');
  });
});
