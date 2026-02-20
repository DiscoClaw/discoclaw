import { describe, expect, it, vi } from 'vitest';
import {
  buildAttachments,
  imageMediaTypeToExtension,
  editThenSendChunks,
  replyThenSendChunks,
  sendChunks,
  shouldSuppressFollowUp,
  buildUnavailableActionTypesNotice,
  appendUnavailableActionTypesNotice,
} from './output-common.js';
import type { ImageData } from '../runtime/types.js';

describe('imageMediaTypeToExtension', () => {
  it('maps known types', () => {
    expect(imageMediaTypeToExtension('image/png')).toBe('png');
    expect(imageMediaTypeToExtension('image/jpeg')).toBe('jpeg');
    expect(imageMediaTypeToExtension('image/webp')).toBe('webp');
    expect(imageMediaTypeToExtension('image/gif')).toBe('gif');
  });

  it('defaults to png for unknown', () => {
    expect(imageMediaTypeToExtension('image/bmp')).toBe('png');
  });
});

describe('buildAttachments', () => {
  it('creates correct filenames and buffers', () => {
    const images: ImageData[] = [
      { base64: Buffer.from('png-data').toString('base64'), mediaType: 'image/png' },
      { base64: Buffer.from('jpeg-data').toString('base64'), mediaType: 'image/jpeg' },
    ];
    const attachments = buildAttachments(images);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].name).toBe('image-1.png');
    expect(attachments[1].name).toBe('image-2.jpeg');
  });

  it('returns empty array for empty input', () => {
    expect(buildAttachments([])).toHaveLength(0);
  });
});

describe('editThenSendChunks with images', () => {
  function mockReply() {
    return { edit: vi.fn().mockResolvedValue(undefined) };
  }
  function mockChannel() {
    return { send: vi.fn().mockResolvedValue(undefined) };
  }

  it('sends text-only with no images', async () => {
    const reply = mockReply();
    const channel = mockChannel();
    await editThenSendChunks(reply, channel, 'hello');
    expect(reply.edit).toHaveBeenCalledOnce();
    expect(reply.edit.mock.calls[0][0].content).toBe('hello');
    expect(reply.edit.mock.calls[0][0].files).toBeUndefined();
  });

  it('sends image-only when text is empty', async () => {
    const reply = mockReply();
    const channel = mockChannel();
    const images: ImageData[] = [
      { base64: Buffer.from('test').toString('base64'), mediaType: 'image/png' },
    ];
    await editThenSendChunks(reply, channel, '', images);
    expect(reply.edit).toHaveBeenCalledOnce();
    expect(reply.edit.mock.calls[0][0].content).toBe('');
    expect(reply.edit.mock.calls[0][0].files).toHaveLength(1);
  });

  it('attaches images to single text chunk in one edit', async () => {
    const reply = mockReply();
    const channel = mockChannel();
    const images: ImageData[] = [
      { base64: Buffer.from('test').toString('base64'), mediaType: 'image/png' },
    ];
    await editThenSendChunks(reply, channel, 'Response text', images);
    // Should only call edit once (no double-edit)
    expect(reply.edit).toHaveBeenCalledOnce();
    expect(reply.edit.mock.calls[0][0].content).toBe('Response text');
    expect(reply.edit.mock.calls[0][0].files).toHaveLength(1);
  });

  it('attaches images to last chunk in multi-chunk text', async () => {
    const reply = mockReply();
    const channel = mockChannel();
    const images: ImageData[] = [
      { base64: Buffer.from('img').toString('base64'), mediaType: 'image/png' },
    ];
    // Generate text long enough to split into multiple chunks (>2000 chars)
    const longText = 'A'.repeat(2100);
    await editThenSendChunks(reply, channel, longText, images);
    // First chunk via edit (no files), remaining via channel.send
    expect(reply.edit).toHaveBeenCalledOnce();
    expect(reply.edit.mock.calls[0][0].files).toBeUndefined();
    // Last send should have files
    const sendCalls = channel.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const lastSend = sendCalls[sendCalls.length - 1][0];
    expect(lastSend.files).toHaveLength(1);
  });

  it('shows (no output) when empty text and no images', async () => {
    const reply = mockReply();
    const channel = mockChannel();
    await editThenSendChunks(reply, channel, '');
    expect(reply.edit).toHaveBeenCalledOnce();
    expect(reply.edit.mock.calls[0][0].content).toBe('(no output)');
  });
});

describe('replyThenSendChunks with images', () => {
  function mockMessage() {
    return {
      reply: vi.fn().mockResolvedValue(undefined),
      channel: { send: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('sends image-only with empty text', async () => {
    const message = mockMessage();
    const images: ImageData[] = [
      { base64: Buffer.from('test').toString('base64'), mediaType: 'image/png' },
    ];
    await replyThenSendChunks(message, '', images);
    expect(message.reply).toHaveBeenCalledOnce();
    expect(message.reply.mock.calls[0][0].content).toBe('');
    expect(message.reply.mock.calls[0][0].files).toHaveLength(1);
  });

  it('shows (no output) when no text and no images', async () => {
    const message = mockMessage();
    await replyThenSendChunks(message, '');
    expect(message.reply).toHaveBeenCalledOnce();
    expect(message.reply.mock.calls[0][0].content).toBe('(no output)');
  });
});

describe('shouldSuppressFollowUp', () => {
  it('suppresses when text is short and all counts are zero', () => {
    expect(shouldSuppressFollowUp('hi', 0, 0, 0)).toBe(true);
  });

  it('suppresses when text is empty and all counts are zero', () => {
    expect(shouldSuppressFollowUp('', 0, 0, 0)).toBe(true);
  });

  it('suppresses when whitespace-collapsed text is under 50 chars', () => {
    const text = '   a   b   c   '; // collapses to "a b c" (5 chars)
    expect(shouldSuppressFollowUp(text, 0, 0, 0)).toBe(true);
  });

  it('does not suppress when text is 50 chars or more', () => {
    const text = 'A'.repeat(50);
    expect(shouldSuppressFollowUp(text, 0, 0, 0)).toBe(false);
  });

  it('does not suppress when actionsCount > 0', () => {
    expect(shouldSuppressFollowUp('hi', 1, 0, 0)).toBe(false);
  });

  it('does not suppress when imagesCount > 0', () => {
    expect(shouldSuppressFollowUp('hi', 0, 1, 0)).toBe(false);
  });

  it('does not suppress when strippedUnrecognizedCount > 0, even with short text', () => {
    expect(shouldSuppressFollowUp('', 0, 0, 1)).toBe(false);
  });

  it('does not suppress when strippedUnrecognizedCount > 0, even with zero actions and images', () => {
    expect(shouldSuppressFollowUp('short', 0, 0, 3)).toBe(false);
  });
});

describe('buildUnavailableActionTypesNotice', () => {
  it('returns empty string when no types were stripped', () => {
    expect(buildUnavailableActionTypesNotice([])).toBe('');
  });

  it('renders singular notice for one unavailable type', () => {
    const out = buildUnavailableActionTypesNotice(['channelCreate']);
    expect(out).toContain('Ignored unavailable action type:');
    expect(out).toContain('`channelCreate`');
  });

  it('deduplicates and renders plural notice for multiple unavailable types', () => {
    const out = buildUnavailableActionTypesNotice(['taskSync', 'taskSync', 'planRun']);
    expect(out).toContain('Ignored unavailable action types:');
    expect(out).toContain('`taskSync`');
    expect(out).toContain('`planRun`');
  });
});

describe('appendUnavailableActionTypesNotice', () => {
  it('appends the notice under existing text', () => {
    const out = appendUnavailableActionTypesNotice('hello', ['channelCreate']);
    expect(out).toContain('hello');
    expect(out).toContain('Ignored unavailable action type');
  });

  it('returns notice alone when base text is empty', () => {
    const out = appendUnavailableActionTypesNotice('', ['channelCreate']);
    expect(out.startsWith('Ignored unavailable action type')).toBe(true);
  });

  it('returns original text when no stripped types are provided', () => {
    expect(appendUnavailableActionTypesNotice('hello', [])).toBe('hello');
  });
});

describe('sendChunks with images', () => {
  function mockChannel() {
    return { send: vi.fn().mockResolvedValue(undefined) };
  }

  it('sends image-only with empty text', async () => {
    const channel = mockChannel();
    const images: ImageData[] = [
      { base64: Buffer.from('test').toString('base64'), mediaType: 'image/png' },
    ];
    await sendChunks(channel, '', images);
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.send.mock.calls[0][0].content).toBe('');
    expect(channel.send.mock.calls[0][0].files).toHaveLength(1);
  });

  it('attaches images to last text chunk', async () => {
    const channel = mockChannel();
    const images: ImageData[] = [
      { base64: Buffer.from('test').toString('base64'), mediaType: 'image/png' },
    ];
    await sendChunks(channel, 'Hello world', images);
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.send.mock.calls[0][0].files).toHaveLength(1);
  });
});
