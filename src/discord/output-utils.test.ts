import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stripActionTags } from './output-utils.js';

describe('stripActionTags', () => {
  const originalDisableFlag = process.env.DISCOCLAW_DISABLE_STREAM_SANITIZATION;

  beforeEach(() => {
    delete process.env.DISCOCLAW_DISABLE_STREAM_SANITIZATION;
  });

  afterEach(() => {
    if (originalDisableFlag === undefined) {
      delete process.env.DISCOCLAW_DISABLE_STREAM_SANITIZATION;
    } else {
      process.env.DISCOCLAW_DISABLE_STREAM_SANITIZATION = originalDisableFlag;
    }
  });

  it('strips complete continuation capsule blocks from preview text', () => {
    const input = [
      'Visible start.',
      '<continuation-capsule>',
      '{"currentTask":"Keep focus","nextStep":"Persist capsule","blockers":[]}',
      '</continuation-capsule>',
      'Visible end.',
    ].join('\n');

    expect(stripActionTags(input)).toBe('Visible start.\n\nVisible end.');
  });

  it('strips trailing incomplete continuation capsule blocks from preview text', () => {
    const input = [
      'Visible start.',
      '<continuation-capsule>',
      '{"currentTask":"Keep focus"',
    ].join('\n');

    expect(stripActionTags(input)).toBe('Visible start.\n');
  });
});
