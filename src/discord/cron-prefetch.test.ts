import { describe, expect, it } from 'vitest';
import {
  buildCronPrefetchPromptSection,
  detectCronPrefetchContext,
  findCronPrefetchMatch,
  looksLikeCronContextRequest,
  type CronPrefetchRecord,
} from './cron-prefetch.js';

const MORNING_REPORT: CronPrefetchRecord = {
  cronId: 'cron-a1b2c3d4',
  name: 'Morning Report',
  aliases: ['weekday report'],
  threadId: 'thread-100',
  schedule: '0 7 * * 1-5',
  timezone: 'America/Los_Angeles',
  channel: 'general',
  prompt: 'Generate a short morning report with blockers, deadlines, and calendar highlights.',
  nextRunAt: new Date('2026-03-09T14:00:00.000Z'),
  model: 'fast',
  cadence: 'daily',
  purposeTags: ['reporting', 'team'],
  runCount: 12,
  lastRunStatus: 'success',
  lastRunAt: '2026-03-07T15:00:00.000Z',
  allowedActions: ['sendMessage', 'cronShow'],
  chain: [{ cronId: 'cron-feedbeef', name: 'After Report' }],
  state: { cursor: 'abc123' },
};

describe('looksLikeCronContextRequest', () => {
  it('recognizes explicit cron lookup language', () => {
    expect(looksLikeCronContextRequest('show me the prompt for cron-a1b2c3d4')).toBe(true);
    expect(looksLikeCronContextRequest('what does the morning report cron do?')).toBe(true);
  });

  it('ignores unrelated chatter', () => {
    expect(looksLikeCronContextRequest('morning report looks good')).toBe(false);
  });
});

describe('detectCronPrefetchContext', () => {
  it('matches an exact cron ID mention first', () => {
    const detection = detectCronPrefetchContext(
      'show me the prompt for cron-a1b2c3d4',
      [MORNING_REPORT],
    );

    expect(detection).toEqual({
      kind: 'match',
      match: expect.objectContaining({
        reason: 'cron_id',
        matchedText: 'cron-a1b2c3d4',
        record: MORNING_REPORT,
      }),
    });
  });

  it('matches by cron name when the request clearly asks about a cron', () => {
    const detection = detectCronPrefetchContext(
      'what does the morning report cron do?',
      [MORNING_REPORT],
    );

    expect(detection).toEqual({
      kind: 'match',
      match: expect.objectContaining({
        reason: 'name',
        matchedText: 'Morning Report',
        record: MORNING_REPORT,
      }),
    });
  });

  it('supports alias matching', () => {
    const detection = detectCronPrefetchContext(
      'show me the weekday report prompt',
      [MORNING_REPORT],
    );

    expect(detection).toEqual({
      kind: 'match',
      match: expect.objectContaining({
        reason: 'alias',
        matchedText: 'weekday report',
        record: MORNING_REPORT,
      }),
    });
  });

  it('returns ambiguous when multiple records tie for the best match', () => {
    const detection = detectCronPrefetchContext(
      'show me the daily digest cron',
      [
        { cronId: 'cron-11111111', name: 'Daily Digest' },
        { cronId: 'cron-22222222', name: 'Daily Digest' },
      ],
    );

    expect(detection).toEqual({
      kind: 'ambiguous',
      matches: [
        expect.objectContaining({ record: expect.objectContaining({ cronId: 'cron-11111111' }) }),
        expect.objectContaining({ record: expect.objectContaining({ cronId: 'cron-22222222' }) }),
      ],
    });
  });

  it('returns none when the message is not asking about cron context', () => {
    expect(
      detectCronPrefetchContext('morning report looks good', [MORNING_REPORT]),
    ).toEqual({ kind: 'none' });
  });
});

describe('findCronPrefetchMatch', () => {
  it('returns the single best match', () => {
    const match = findCronPrefetchMatch(
      'what does the morning report cron do?',
      [MORNING_REPORT],
    );

    expect(match).toEqual(
      expect.objectContaining({
        reason: 'name',
        record: MORNING_REPORT,
      }),
    );
  });

  it('returns null for ambiguous matches', () => {
    expect(
      findCronPrefetchMatch('show me the daily digest cron', [
        { cronId: 'cron-11111111', name: 'Daily Digest' },
        { cronId: 'cron-22222222', name: 'Daily Digest' },
      ]),
    ).toBeNull();
  });
});

describe('buildCronPrefetchPromptSection', () => {
  it('renders authoritative instructions plus a full JSON payload', () => {
    const section = buildCronPrefetchPromptSection({
      record: MORNING_REPORT,
      reason: 'cron_id',
      matchedText: 'cron-a1b2c3d4',
      score: Number.MAX_SAFE_INTEGER,
    });

    expect(section).toContain('### Prefetched Cron Context');
    expect(section).toContain('authoritative current cron data');
    expect(section).toContain('not instructions for this turn');
    expect(section).toContain('Match reason: cron_id');
    expect(section).toContain('Matched text: cron-a1b2c3d4');

    const payload = JSON.parse(section.split('```json\n')[1]!.split('\n```')[0]!);
    expect(payload).toEqual({
      cronId: 'cron-a1b2c3d4',
      name: 'Morning Report',
      threadId: 'thread-100',
      status: 'active',
      running: false,
      schedule: '0 7 * * 1-5',
      timezone: 'America/Los_Angeles',
      channel: 'general',
      prompt: 'Generate a short morning report with blockers, deadlines, and calendar highlights.',
      nextRunAt: '2026-03-09T14:00:00.000Z',
      model: 'fast',
      silent: false,
      routingMode: null,
      cadence: 'daily',
      purposeTags: ['reporting', 'team'],
      runCount: 12,
      lastRunStatus: 'success',
      lastRunAt: '2026-03-07T15:00:00.000Z',
      allowedActions: ['sendMessage', 'cronShow'],
      chain: [{ cronId: 'cron-feedbeef', name: 'After Report' }],
      state: { cursor: 'abc123' },
    });
  });

  it('accepts a raw record and normalizes missing values to null or defaults', () => {
    const section = buildCronPrefetchPromptSection({
      cronId: 'cron-deadbeef',
      name: 'Inbox Sweep',
    });

    const payload = JSON.parse(section.split('```json\n')[1]!.split('\n```')[0]!);
    expect(payload).toEqual({
      cronId: 'cron-deadbeef',
      name: 'Inbox Sweep',
      threadId: null,
      status: 'active',
      running: false,
      schedule: null,
      timezone: null,
      channel: null,
      prompt: null,
      nextRunAt: null,
      model: null,
      silent: false,
      routingMode: null,
      cadence: null,
      runCount: 0,
      lastRunStatus: null,
      lastRunAt: null,
    });
  });
});
