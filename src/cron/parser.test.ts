import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCronDefinition } from './parser.js';
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
