import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseJsonRouteEntries, handleJsonRouteOutput } from './json-router.js';
import type { JsonRouteEntry } from './json-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSendChannel() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

function makeResolver(map: Record<string, ReturnType<typeof makeSendChannel>>) {
  return (ref: string) => map[ref];
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// parseJsonRouteEntries
// ---------------------------------------------------------------------------

describe('parseJsonRouteEntries', () => {
  it('returns entries for a valid JSON array', () => {
    const input = JSON.stringify([
      { channel: 'general', content: 'Hello!' },
      { channel: 'alerts', content: 'Alert!' },
    ]);
    const result = parseJsonRouteEntries(input);
    expect(result).toEqual<JsonRouteEntry[]>([
      { channel: 'general', content: 'Hello!' },
      { channel: 'alerts', content: 'Alert!' },
    ]);
  });

  it('returns an empty array for []', () => {
    expect(parseJsonRouteEntries('[]')).toEqual([]);
  });

  it('returns null for invalid JSON', () => {
    expect(parseJsonRouteEntries('not json')).toBeNull();
  });

  it('returns null for a JSON object (not an array)', () => {
    expect(parseJsonRouteEntries('{"channel":"general","content":"hi"}')).toBeNull();
  });

  it('returns null for a JSON string', () => {
    expect(parseJsonRouteEntries('"hello"')).toBeNull();
  });

  it('returns null for a JSON number', () => {
    expect(parseJsonRouteEntries('42')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseJsonRouteEntries('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseJsonRouteEntries('   \n  ')).toBeNull();
  });

  it('strips ```json code fences before parsing', () => {
    const input = '```json\n[{"channel":"general","content":"hi"}]\n```';
    expect(parseJsonRouteEntries(input)).toEqual([{ channel: 'general', content: 'hi' }]);
  });

  it('strips ``` code fences (no language tag) before parsing', () => {
    const input = '```\n[{"channel":"alerts","content":"yo"}]\n```';
    expect(parseJsonRouteEntries(input)).toEqual([{ channel: 'alerts', content: 'yo' }]);
  });

  it('returns null when code fences contain invalid JSON', () => {
    const input = '```json\nnot valid\n```';
    expect(parseJsonRouteEntries(input)).toBeNull();
  });

  it('skips entries missing the channel field', () => {
    const input = JSON.stringify([{ content: 'no channel here' }]);
    expect(parseJsonRouteEntries(input)).toEqual([]);
  });

  it('skips entries missing the content field', () => {
    const input = JSON.stringify([{ channel: 'general' }]);
    expect(parseJsonRouteEntries(input)).toEqual([]);
  });

  it('skips entries with a non-string channel', () => {
    const input = JSON.stringify([{ channel: 42, content: 'hi' }]);
    expect(parseJsonRouteEntries(input)).toEqual([]);
  });

  it('skips entries with a non-string content', () => {
    const input = JSON.stringify([{ channel: 'general', content: true }]);
    expect(parseJsonRouteEntries(input)).toEqual([]);
  });

  it('skips null entries', () => {
    const input = JSON.stringify([null, { channel: 'general', content: 'valid' }]);
    expect(parseJsonRouteEntries(input)).toEqual([{ channel: 'general', content: 'valid' }]);
  });

  it('returns only valid entries from a mixed array', () => {
    const input = JSON.stringify([
      { channel: 'general', content: 'good' },
      { channel: 42, content: 'bad channel' },
      null,
      { channel: 'alerts', content: 'also good' },
    ]);
    expect(parseJsonRouteEntries(input)).toEqual([
      { channel: 'general', content: 'good' },
      { channel: 'alerts', content: 'also good' },
    ]);
  });

  it('preserves extra fields on valid entries (only channel and content are extracted)', () => {
    const input = JSON.stringify([{ channel: 'general', content: 'hi', extra: 'ignored' }]);
    expect(parseJsonRouteEntries(input)).toEqual([{ channel: 'general', content: 'hi' }]);
  });
});

// ---------------------------------------------------------------------------
// handleJsonRouteOutput
// ---------------------------------------------------------------------------

describe('handleJsonRouteOutput — parse failure fallback', () => {
  it('falls back and sends raw output to default channel on parse failure', async () => {
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({});
    const rawOutput = 'not valid json at all';

    const result = await handleJsonRouteOutput(rawOutput, resolver, defaultChannel);

    expect(result.usedFallback).toBe(true);
    expect(result.routedCount).toBe(0);
    expect(defaultChannel.send).toHaveBeenCalledOnce();
    const callArg = defaultChannel.send.mock.calls[0]?.[0] as { content: string };
    expect(callArg.content).toBe(rawOutput);
  });

  it('logs a warning when parse fails', async () => {
    const log = mockLog();
    const defaultChannel = makeSendChannel();
    await handleJsonRouteOutput('bad', makeResolver({}), defaultChannel, { log, jobId: 'cron-1' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('falls back when AI wraps JSON in a non-array structure', async () => {
    const defaultChannel = makeSendChannel();
    const rawOutput = '{"error": "oops"}';
    const result = await handleJsonRouteOutput(rawOutput, makeResolver({}), defaultChannel);
    expect(result.usedFallback).toBe(true);
    expect(defaultChannel.send).toHaveBeenCalledOnce();
  });
});

describe('handleJsonRouteOutput — empty array', () => {
  it('returns routedCount=0 and usedFallback=false for []', async () => {
    const defaultChannel = makeSendChannel();
    const result = await handleJsonRouteOutput('[]', makeResolver({}), defaultChannel);
    expect(result).toEqual({ routedCount: 0, usedFallback: false });
    expect(defaultChannel.send).not.toHaveBeenCalled();
  });

  it('does not log a warning for an empty array', async () => {
    const log = mockLog();
    const defaultChannel = makeSendChannel();
    await handleJsonRouteOutput('[]', makeResolver({}), defaultChannel, { log });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('handleJsonRouteOutput — successful routing', () => {
  it('sends to the resolved channel for a single valid entry', async () => {
    const generalChannel = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ general: generalChannel });
    const output = JSON.stringify([{ channel: 'general', content: 'Hello world' }]);

    const result = await handleJsonRouteOutput(output, resolver, defaultChannel);

    expect(result.usedFallback).toBe(false);
    expect(result.routedCount).toBe(1);
    expect(generalChannel.send).toHaveBeenCalledOnce();
    expect(defaultChannel.send).not.toHaveBeenCalled();
  });

  it('sends to each channel for multiple entries', async () => {
    const generalChannel = makeSendChannel();
    const alertsChannel = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ general: generalChannel, alerts: alertsChannel });
    const output = JSON.stringify([
      { channel: 'general', content: 'msg 1' },
      { channel: 'alerts', content: 'msg 2' },
    ]);

    const result = await handleJsonRouteOutput(output, resolver, defaultChannel);

    expect(result.routedCount).toBe(2);
    expect(result.usedFallback).toBe(false);
    expect(generalChannel.send).toHaveBeenCalledOnce();
    expect(alertsChannel.send).toHaveBeenCalledOnce();
    expect(defaultChannel.send).not.toHaveBeenCalled();
  });

  it('sends the correct content to each channel', async () => {
    const ch1 = makeSendChannel();
    const ch2 = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ alpha: ch1, beta: ch2 });
    const output = JSON.stringify([
      { channel: 'alpha', content: 'alpha message' },
      { channel: 'beta', content: 'beta message' },
    ]);

    await handleJsonRouteOutput(output, resolver, defaultChannel);

    const ch1Call = ch1.send.mock.calls[0]?.[0] as { content: string };
    const ch2Call = ch2.send.mock.calls[0]?.[0] as { content: string };
    expect(ch1Call.content).toBe('alpha message');
    expect(ch2Call.content).toBe('beta message');
  });

  it('resolves channel by ID string', async () => {
    const idChannel = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ '123456789': idChannel });
    const output = JSON.stringify([{ channel: '123456789', content: 'by ID' }]);

    const result = await handleJsonRouteOutput(output, resolver, defaultChannel);

    expect(result.routedCount).toBe(1);
    expect(idChannel.send).toHaveBeenCalledOnce();
  });
});

describe('handleJsonRouteOutput — channel not found', () => {
  it('skips entries whose channel cannot be resolved', async () => {
    const realChannel = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ real: realChannel });
    const output = JSON.stringify([
      { channel: 'real', content: 'ok' },
      { channel: 'missing', content: 'not sent' },
    ]);

    const result = await handleJsonRouteOutput(output, resolver, defaultChannel);

    expect(result.routedCount).toBe(1);
    expect(result.usedFallback).toBe(false);
    expect(realChannel.send).toHaveBeenCalledOnce();
    expect(defaultChannel.send).not.toHaveBeenCalled();
  });

  it('falls back when all entries have unresolvable channels', async () => {
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({});
    const rawOutput = JSON.stringify([{ channel: 'missing', content: 'nope' }]);

    const result = await handleJsonRouteOutput(rawOutput, resolver, defaultChannel);

    expect(result.usedFallback).toBe(true);
    expect(result.routedCount).toBe(0);
    expect(defaultChannel.send).toHaveBeenCalledOnce();
    const callArg = defaultChannel.send.mock.calls[0]?.[0] as { content: string };
    expect(callArg.content).toBe(rawOutput);
  });

  it('logs a warning for each unresolvable channel', async () => {
    const log = mockLog();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({});
    const output = JSON.stringify([
      { channel: 'ghost-1', content: 'a' },
      { channel: 'ghost-2', content: 'b' },
    ]);

    await handleJsonRouteOutput(output, resolver, defaultChannel, { log, jobId: 'job-x' });

    expect(log.warn).toHaveBeenCalledTimes(3); // 2 skips + 1 all-failed
  });
});

describe('handleJsonRouteOutput — send error fallback', () => {
  it('falls back when all channel sends throw', async () => {
    const badChannel = { send: vi.fn().mockRejectedValue(new Error('send failed')) };
    const defaultChannel = makeSendChannel();
    const resolver = (ref: string) => (ref === 'bad' ? badChannel : undefined);
    const rawOutput = JSON.stringify([{ channel: 'bad', content: 'message' }]);

    const result = await handleJsonRouteOutput(rawOutput, resolver, defaultChannel);

    expect(result.usedFallback).toBe(true);
    expect(result.routedCount).toBe(0);
    expect(defaultChannel.send).toHaveBeenCalledOnce();
  });

  it('does not fall back when at least one entry sends successfully', async () => {
    const goodChannel = makeSendChannel();
    const badChannel = { send: vi.fn().mockRejectedValue(new Error('fail')) };
    const defaultChannel = makeSendChannel();
    const resolver = (ref: string) => {
      if (ref === 'good') return goodChannel;
      if (ref === 'bad') return badChannel;
      return undefined;
    };
    const output = JSON.stringify([
      { channel: 'good', content: 'works' },
      { channel: 'bad', content: 'fails' },
    ]);

    const result = await handleJsonRouteOutput(output, resolver, defaultChannel);

    expect(result.usedFallback).toBe(false);
    expect(result.routedCount).toBe(1);
    expect(defaultChannel.send).not.toHaveBeenCalled();
  });

  it('logs a warning when a send throws', async () => {
    const log = mockLog();
    const badChannel = { send: vi.fn().mockRejectedValue(new Error('nope')) };
    const defaultChannel = makeSendChannel();
    const resolver = (ref: string) => (ref === 'bad' ? badChannel : undefined);
    const output = JSON.stringify([{ channel: 'bad', content: 'msg' }]);

    await handleJsonRouteOutput(output, resolver, defaultChannel, { log });

    expect(log.warn).toHaveBeenCalled();
  });
});

describe('handleJsonRouteOutput — code-fenced AI output', () => {
  it('parses and routes entries from code-fenced output', async () => {
    const generalChannel = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ general: generalChannel });
    const output = '```json\n[{"channel":"general","content":"fenced message"}]\n```';

    const result = await handleJsonRouteOutput(output, resolver, defaultChannel);

    expect(result.routedCount).toBe(1);
    expect(result.usedFallback).toBe(false);
    expect(generalChannel.send).toHaveBeenCalledOnce();
  });
});

describe('handleJsonRouteOutput — options', () => {
  it('works without any options argument', async () => {
    const ch = makeSendChannel();
    const defaultChannel = makeSendChannel();
    const resolver = makeResolver({ general: ch });
    const output = JSON.stringify([{ channel: 'general', content: 'no opts' }]);

    await expect(handleJsonRouteOutput(output, resolver, defaultChannel)).resolves.toMatchObject({
      routedCount: 1,
      usedFallback: false,
    });
  });

  it('works with a jobId but no logger', async () => {
    const defaultChannel = makeSendChannel();
    const output = 'bad json';
    await expect(
      handleJsonRouteOutput(output, makeResolver({}), defaultChannel, { jobId: 'cron-99' }),
    ).resolves.toMatchObject({ usedFallback: true });
  });
});
