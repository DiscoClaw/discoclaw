import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCronDefinition, parseStarterContent } from './parser.js';
import type { RuntimeAdapter, EngineEvent } from '../runtime/types.js';

function makeMockRuntime(response: string): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'text_final', text: response };
      yield { type: 'done' };
    },
  };
}

function makeMockRuntimeError(): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'error', message: 'timeout' };
      yield { type: 'done' };
    },
  };
}

describe('parseCronDefinition', () => {
  it('parses a valid JSON response', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      schedule: '0 7 * * 1-5',
      timezone: 'America/Los_Angeles',
      channel: 'general',
      prompt: 'Check the weather for Portland OR and post a brief summary.',
    }));

    const result = await parseCronDefinition('Every weekday at 7am Pacific, check the weather', runtime);
    expect(result).toEqual({
      triggerType: 'schedule',
      schedule: '0 7 * * 1-5',
      timezone: 'America/Los_Angeles',
      channel: 'general',
      prompt: 'Check the weather for Portland OR and post a brief summary.',
    });
  });

  it('handles markdown-fenced JSON', async () => {
    const json = JSON.stringify({
      schedule: '* * * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
    const runtime = makeMockRuntime('```json\n' + json + '\n```');

    const result = await parseCronDefinition('Every minute, say hello to #general', runtime);
    expect(result).toEqual({
      triggerType: 'schedule',
      schedule: '* * * * *',
      timezone: 'UTC',
      channel: 'general',
      prompt: 'Say hello.',
    });
  });

  it('strips # from channel name', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      schedule: '0 9 * * 1',
      timezone: 'UTC',
      channel: '#announcements',
      prompt: 'Post weekly update.',
    }));

    const result = await parseCronDefinition('Every Monday at 9am, post to #announcements', runtime);
    expect(result?.channel).toBe('announcements');
  });

  it('returns null on runtime error', async () => {
    const runtime = makeMockRuntimeError();
    const result = await parseCronDefinition('test', runtime);
    expect(result).toBeNull();
  });

  it('returns null on empty output', async () => {
    const runtime = makeMockRuntime('');
    const result = await parseCronDefinition('test', runtime);
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const runtime = makeMockRuntime('not json at all');
    const result = await parseCronDefinition('test', runtime);
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      schedule: '0 7 * * *',
      timezone: 'UTC',
    }));

    const result = await parseCronDefinition('test', runtime);
    expect(result).toBeNull();
  });

  it('defaults timezone to UTC when empty and DEFAULT_TIMEZONE=UTC', async () => {
    vi.stubEnv('DEFAULT_TIMEZONE', 'UTC');
    const runtime = makeMockRuntime(JSON.stringify({
      schedule: '0 7 * * *',
      timezone: '',
      channel: 'general',
      prompt: 'Do something.',
    }));

    const result = await parseCronDefinition('test', runtime);
    expect(result?.timezone).toBe('UTC');
    vi.unstubAllEnvs();
  });

  it('defaults timezone to system timezone when empty and no env override', async () => {
    vi.stubEnv('DEFAULT_TIMEZONE', '');
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const runtime = makeMockRuntime(JSON.stringify({
      schedule: '0 7 * * *',
      timezone: '',
      channel: 'general',
      prompt: 'Do something.',
    }));

    const result = await parseCronDefinition('test', runtime);
    expect(result?.timezone).toBe(systemTz);
    vi.unstubAllEnvs();
  });
});

describe('parseStarterContent', () => {
  it('parses standard prompt-only format', () => {
    const text = [
      '**Schedule:** `0 7 * * 1-5` (America/Los_Angeles)',
      '**Channel:** #general',
      '**Input:** prompt-only',
      '',
      'Check the weather for Portland OR and post a brief summary.',
    ].join('\n');

    expect(parseStarterContent(text)).toEqual({
      triggerType: 'schedule',
      schedule: '0 7 * * 1-5',
      timezone: 'America/Los_Angeles',
      channel: 'general',
      prompt: 'Check the weather for Portland OR and post a brief summary.',
    });
  });

  it('parses shell-input format with bash block', () => {
    const text = [
      '**Schedule:** `*/30 * * * *` (UTC)',
      '**Channel:** #ops',
      '**Input:** shell-input',
      '```bash',
      'curl -s https://api.example.com/status',
      '```',
      '',
      'Summarize the API status and report any errors.',
    ].join('\n');

    expect(parseStarterContent(text)).toEqual({
      triggerType: 'schedule',
      schedule: '*/30 * * * *',
      timezone: 'UTC',
      channel: 'ops',
      prompt: 'Summarize the API status and report any errors.',
    });
  });

  it('parses truncated prompt (with continuation marker)', () => {
    const longPrompt = 'A'.repeat(200) + '… *(full prompt pinned below)*';
    const text = [
      '**Schedule:** `0 9 * * 1` (Europe/London)',
      '**Channel:** #reports',
      '**Input:** prompt-only',
      '',
      longPrompt,
    ].join('\n');

    const result = parseStarterContent(text);
    expect(result).not.toBeNull();
    expect(result!.schedule).toBe('0 9 * * 1');
    expect(result!.timezone).toBe('Europe/London');
    expect(result!.channel).toBe('reports');
    expect(result!.prompt).toBe(longPrompt);
  });

  it('returns null when schedule line is missing', () => {
    const text = [
      '**Channel:** #general',
      '**Input:** prompt-only',
      '',
      'Do something.',
    ].join('\n');

    expect(parseStarterContent(text)).toBeNull();
  });

  it('returns null when channel line is missing', () => {
    const text = [
      '**Schedule:** `0 7 * * *` (UTC)',
      '**Input:** prompt-only',
      '',
      'Do something.',
    ].join('\n');

    expect(parseStarterContent(text)).toBeNull();
  });

  it('returns null when prompt body is missing', () => {
    const text = [
      '**Schedule:** `0 7 * * *` (UTC)',
      '**Channel:** #general',
      '**Input:** prompt-only',
      '',
    ].join('\n');

    expect(parseStarterContent(text)).toBeNull();
  });

  it('returns null for non-bot-formatted freeform text', () => {
    const text = 'Every weekday at 7am Pacific, check the weather and post to #general';
    expect(parseStarterContent(text)).toBeNull();
  });

  it('parses channel with ID instead of name', () => {
    const text = [
      '**Schedule:** `0 12 * * *` (UTC)',
      '**Channel:** #1234567890',
      '**Input:** prompt-only',
      '',
      'Post the daily digest.',
    ].join('\n');

    const result = parseStarterContent(text);
    expect(result).not.toBeNull();
    expect(result!.channel).toBe('1234567890');
  });
});
