import { describe, expect, it, vi } from 'vitest';

import {
  buildLongRunFinalNotice,
  buildLongRunStagingFailureNotice,
  postLongRunWatchdogNoticeToChannel,
} from './long-run-watchdog-notice.js';

describe('buildLongRunFinalNotice', () => {
  it('includes persisted failure detail in the final notice', () => {
    expect(buildLongRunFinalNotice({
      completion: 'failed',
      completionDetail: 'Forge failed during plan-553: codex app-server websocket closed',
      source: 'complete',
    })).toBe('Run ended with errors.\nReason: Forge failed during plan-553: codex app-server websocket closed');
  });

  it('sanitizes leaked prompt content in failure detail and preserves restart recovery suffixes', () => {
    const detail = 'Command failed with exit code 1: claude -p "You are a helpful assistant..."';
    expect(buildLongRunFinalNotice({
      completion: 'failed',
      completionDetail: detail,
      source: 'startup-sweep',
    })).toBe('Run ended with errors. (Recovered after restart.)\nReason: Command failed with exit code 1');
  });

  it('renders recovered success summaries from persisted watchdog payloads', () => {
    expect(buildLongRunFinalNotice({
      completion: 'succeeded',
      recoveryText: 'Summary restored from watchdog.\n- Updated task state',
      source: 'startup-sweep',
    })).toBe('Summary restored from watchdog.\n- Updated task state\n\nRecovered after restart.');
  });

  it('renders recovered no-prose notices from persisted watchdog payloads', () => {
    expect(buildLongRunFinalNotice({
      completion: 'succeeded',
      recoveryText: 'Completed successfully. Discord actions ran, but there was no additional reply text.',
      source: 'startup-sweep',
    })).toBe('Completed successfully. Discord actions ran, but there was no additional reply text.\n\nRecovered after restart.');
  });

  it('falls back to the generic completion notice when no recovery payload exists', () => {
    expect(buildLongRunFinalNotice({
      completion: 'succeeded',
      source: 'startup-sweep',
    })).toBe('Run complete. (Recovered after restart.)');
  });
});

describe('buildLongRunStagingFailureNotice', () => {
  it('renders the coordinator staging-failure notice after existing visible text', () => {
    expect(buildLongRunStagingFailureNotice(
      'Completed successfully. Discord actions ran, but there was no additional reply text.',
    )).toBe(
      'Completed successfully. Discord actions ran, but there was no additional reply text.\n\nFinal delivery safeguard failed before I could post the terminal reply. Leaving this message visible instead of deleting it.',
    );
  });
});

describe('postLongRunWatchdogNoticeToChannel', () => {
  it('edits the original bot-authored progress message when it is still editable', async () => {
    const source = {
      author: { id: 'bot-1' },
      editable: true,
      edit: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
    const channel = {
      send: vi.fn(async () => {}),
      messages: {
        fetch: vi.fn(async () => source),
      },
    };

    const result = await postLongRunWatchdogNoticeToChannel(channel, {
      messageId: 'msg-1',
      content: 'Run interrupted by restart/shutdown.',
      botUserId: 'bot-1',
    });

    expect(result).toBe('edited');
    expect(source.edit).toHaveBeenCalledWith({
      content: 'Run interrupted by restart/shutdown.',
      allowedMentions: { parse: [] },
    });
    expect(source.reply).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('replies to the source message when it is not editable', async () => {
    const source = {
      author: { id: 'user-1' },
      editable: false,
      reply: vi.fn(async () => {}),
    };
    const channel = {
      send: vi.fn(async () => {}),
      messages: {
        fetch: vi.fn(async () => source),
      },
    };

    const result = await postLongRunWatchdogNoticeToChannel(channel, {
      messageId: 'msg-1',
      content: 'Run complete.',
      botUserId: 'bot-1',
    });

    expect(result).toBe('replied');
    expect(source.reply).toHaveBeenCalledWith({
      content: 'Run complete.',
      allowedMentions: { parse: [] },
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('falls back to sending in-channel when the source message cannot be fetched', async () => {
    const channel = {
      send: vi.fn(async () => {}),
      messages: {
        fetch: vi.fn(async () => null),
      },
    };

    const result = await postLongRunWatchdogNoticeToChannel(channel, {
      messageId: 'msg-1',
      content: 'Run ended with errors.',
      botUserId: 'bot-1',
    });

    expect(result).toBe('sent');
    expect(channel.send).toHaveBeenCalledWith({
      content: 'Run ended with errors.',
      allowedMentions: { parse: [] },
    });
  });
});
