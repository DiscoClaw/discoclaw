import { describe, it, expect } from 'vitest';
import { VOICE_STYLE_INSTRUCTION } from './voice-style-prompt.js';

describe('VOICE_STYLE_INSTRUCTION', () => {
  it('is a non-empty string', () => {
    expect(typeof VOICE_STYLE_INSTRUCTION).toBe('string');
    expect(VOICE_STYLE_INSTRUCTION.length).toBeGreaterThan(0);
  });

  it('is under 500 characters', () => {
    expect(VOICE_STYLE_INSTRUCTION.length).toBeLessThan(500);
  });

  it('does not contain markdown formatting characters', () => {
    expect(VOICE_STYLE_INSTRUCTION).not.toMatch(/[#*`_~]/);
  });

  it('contains key term "telegraphic"', () => {
    expect(VOICE_STYLE_INSTRUCTION.toLowerCase()).toContain('telegraphic');
  });

  it('contains key term "no markdown"', () => {
    expect(VOICE_STYLE_INSTRUCTION.toLowerCase()).toContain('no markdown');
  });

  it('contains key term "codes" or "IDs"', () => {
    const lower = VOICE_STYLE_INSTRUCTION.toLowerCase();
    expect(lower.includes('codes') || lower.includes('ids')).toBe(true);
  });
});
