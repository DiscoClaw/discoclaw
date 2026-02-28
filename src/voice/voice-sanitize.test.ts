import { describe, it, expect } from 'vitest';
import { sanitizeForVoice } from './voice-sanitize.js';

describe('sanitizeForVoice', () => {
  // -- Task IDs ---------------------------------------------------------------

  it('strips backtick-wrapped task IDs from task list output', () => {
    const input = '`ws-1064` [in_progress] P2 — Fix voice agent reading task IDs verbatim';
    expect(sanitizeForVoice(input)).toBe('[in_progress] P2 — Fix voice agent reading task IDs verbatim');
  });

  it('strips parenthesized backtick task IDs from task show output', () => {
    const input = '**Deploy voice pipeline** (`plan-319`)';
    expect(sanitizeForVoice(input)).toBe('**Deploy voice pipeline**');
  });

  it('strips multiple task IDs on separate lines', () => {
    const input = [
      '`ws-1064` [in_progress] P2 — Fix voice reading IDs',
      '`ws-1065` [open] P3 — Add TTS cache',
      '`dc-42` [done] P1 — Update allowlist',
    ].join('\n');
    const expected = [
      '[in_progress] P2 — Fix voice reading IDs',
      '[open] P3 — Add TTS cache',
      '[done] P1 — Update allowlist',
    ].join('\n');
    expect(sanitizeForVoice(input)).toBe(expected);
  });

  // -- Commit hashes ----------------------------------------------------------

  it('strips 7-char commit hashes', () => {
    const input = '0de0834 feat: add deep model tier';
    expect(sanitizeForVoice(input)).toBe('feat: add deep model tier');
  });

  it('strips full 40-char commit hashes', () => {
    const input = 'Commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 merged';
    expect(sanitizeForVoice(input)).toBe('Commit merged');
  });

  it('does not strip short hex strings (under 7 chars)', () => {
    const input = 'Color abc123 is nice';
    expect(sanitizeForVoice(input)).toBe('Color abc123 is nice');
  });

  it('does not strip pure-alpha hex-length strings', () => {
    // "abcdefg" is 7 hex chars but has no digit — not a commit hash
    const input = 'The word abcdefg appears here';
    expect(sanitizeForVoice(input)).toBe('The word abcdefg appears here');
  });

  // -- Discord snowflakes -----------------------------------------------------

  it('strips Discord snowflake IDs', () => {
    const input = 'Channel 12345678901234567 is active';
    expect(sanitizeForVoice(input)).toBe('Channel is active');
  });

  it('strips 20-digit snowflakes', () => {
    const input = 'User 12345678901234567890 joined';
    expect(sanitizeForVoice(input)).toBe('User joined');
  });

  it('does not strip regular short numbers', () => {
    const input = 'There are 5 tasks and 42 open issues';
    expect(sanitizeForVoice(input)).toBe('There are 5 tasks and 42 open issues');
  });

  // -- PR/issue references ----------------------------------------------------

  it('strips parenthesized PR references', () => {
    const input = 'feat: add deep model tier (#485)';
    expect(sanitizeForVoice(input)).toBe('feat: add deep model tier');
  });

  // -- Combined patterns ------------------------------------------------------

  it('strips commit hash + PR ref from a typical git log line', () => {
    const input = '0de0834 feat: add deep model tier for Opus-class tasks (#485)';
    expect(sanitizeForVoice(input)).toBe('feat: add deep model tier for Opus-class tasks');
  });

  it('handles a full task show block', () => {
    const input = [
      '**Fix voice agent reading task IDs verbatim** (`ws-1064`)',
      'Status: in_progress | Priority: P2',
      'Owner: david',
      'Labels: voice, bug',
    ].join('\n');
    const expected = [
      '**Fix voice agent reading task IDs verbatim**',
      'Status: in_progress | Priority: P2',
      'Owner: david',
      'Labels: voice, bug',
    ].join('\n');
    expect(sanitizeForVoice(input)).toBe(expected);
  });

  // -- Preservation (no false positives) --------------------------------------

  it('preserves priority labels like P2', () => {
    const input = 'Priority: P2';
    expect(sanitizeForVoice(input)).toBe('Priority: P2');
  });

  it('preserves status labels', () => {
    const input = '[in_progress] [open] [done]';
    expect(sanitizeForVoice(input)).toBe('[in_progress] [open] [done]');
  });

  it('preserves normal prose', () => {
    const input = 'The voice pipeline is working well today. 3 tasks remain.';
    expect(sanitizeForVoice(input)).toBe('The voice pipeline is working well today. 3 tasks remain.');
  });

  it('preserves backtick-wrapped non-ID text', () => {
    const input = 'Run `pnpm build` to compile';
    expect(sanitizeForVoice(input)).toBe('Run `pnpm build` to compile');
  });

  // -- Edge cases -------------------------------------------------------------

  it('returns empty string for empty input', () => {
    expect(sanitizeForVoice('')).toBe('');
  });

  it('returns empty string for undefined-like input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeForVoice(undefined as any)).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeForVoice(null as any)).toBe('');
  });

  it('collapses double spaces left by removals', () => {
    const input = 'Before `ws-1` after';
    expect(sanitizeForVoice(input)).toBe('Before after');
  });

  it('trims leading/trailing whitespace from result', () => {
    const input = '  `ws-1` hello  ';
    expect(sanitizeForVoice(input)).toBe('hello');
  });
});
