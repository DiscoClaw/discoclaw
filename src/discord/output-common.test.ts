import { describe, expect, it, vi } from 'vitest';
import {
  buildAttachments,
  imageMediaTypeToExtension,
  editThenSendChunks,
  replyThenSendChunks,
  sendChunks,
  shouldSuppressFollowUp,
  claimsImmediateDiscordActionIntent,
  buildUnavailableActionTypesNotice,
  appendUnavailableActionTypesNotice,
  buildParseFailureNotice,
  appendParseFailureNotice,
  buildPromisedDiscordActionWithoutExecutionNotice,
  appendPromisedDiscordActionWithoutExecutionNotice,
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

describe('claimsImmediateDiscordActionIntent', () => {
  it('matches immediate first-person action intent', () => {
    expect(claimsImmediateDiscordActionIntent("I'm creating that task now.")).toBe(true);
  });

  it('matches guidance-targeted progress phrases that imply Discord-managed work is underway', () => {
    expect(claimsImmediateDiscordActionIntent('Proceeding now.')).toBe(true);
    expect(claimsImmediateDiscordActionIntent("I'm cleaning that up now.")).toBe(true);
    expect(claimsImmediateDiscordActionIntent('Taking the next pass.')).toBe(true);
    expect(claimsImmediateDiscordActionIntent('Already handling it.')).toBe(true);
  });

  it('does not match capability explanations', () => {
    expect(claimsImmediateDiscordActionIntent('I can create that task with a taskCreate action block when you are ready.')).toBe(false);
  });

  it('does not match explicit not-started-yet replies', () => {
    expect(claimsImmediateDiscordActionIntent('I have not started yet.')).toBe(false);
  });

  it('does not match quoted example discord-action text', () => {
    expect(claimsImmediateDiscordActionIntent('Example only: `<discord-action>{"type":"taskCreate","title":"Ship it"}</discord-action>`')).toBe(false);
  });

  it('does not match prose that discusses actions without claiming current execution', () => {
    expect(claimsImmediateDiscordActionIntent('To create that task, I would emit a taskCreate action block with the title and details.')).toBe(false);
  });

  it('does not match generic let-me/check phrasing', () => {
    expect(claimsImmediateDiscordActionIntent('Let me check that now.')).toBe(false);
  });

  it('does not match generic show/read/list phrasing', () => {
    expect(claimsImmediateDiscordActionIntent("I'll show you that now.")).toBe(false);
    expect(claimsImmediateDiscordActionIntent("I'm reading that now.")).toBe(false);
    expect(claimsImmediateDiscordActionIntent("I'm listing that now.")).toBe(false);
  });
});

describe('buildPromisedDiscordActionWithoutExecutionNotice', () => {
  it('returns empty string when the reply does not claim immediate action intent', () => {
    expect(buildPromisedDiscordActionWithoutExecutionNotice('I have not started yet.', 0, 0)).toBe('');
  });

  it('returns empty string when actionable work or results exist', () => {
    expect(buildPromisedDiscordActionWithoutExecutionNotice("I'm creating that task now.", 1, 0)).toBe('');
    expect(buildPromisedDiscordActionWithoutExecutionNotice("I'm creating that task now.", 0, 1)).toBe('');
  });

  it('returns a warning when the reply promises current work but nothing ran', () => {
    const out = buildPromisedDiscordActionWithoutExecutionNotice("I'm creating that task now.", 0, 0);
    expect(out).toContain('Discord-managed work is starting or being handled now');
    expect(out).toContain('zero actionable `<discord-action>` blocks');
    expect(out).toContain('zero executed action results');
  });

  it('returns a warning for progress phrases the prompt guidance already forbids without actions', () => {
    const out = buildPromisedDiscordActionWithoutExecutionNotice('Taking the next pass now.', 0, 0);
    expect(out).toContain('Discord-managed work is starting or being handled now');
  });

  it('returns empty string for generic assistant prose without Discord-action intent', () => {
    expect(buildPromisedDiscordActionWithoutExecutionNotice('Let me check that now.', 0, 0)).toBe('');
    expect(buildPromisedDiscordActionWithoutExecutionNotice("I'll show you that now.", 0, 0)).toBe('');
  });
});

describe('appendPromisedDiscordActionWithoutExecutionNotice', () => {
  it('appends the warning beneath the visible reply text', () => {
    const out = appendPromisedDiscordActionWithoutExecutionNotice("I'm creating that task now.", 0, 0);
    expect(out).toContain("I'm creating that task now.");
    expect(out).toContain('zero actionable `<discord-action>` blocks');
  });

  it('returns the original text when no warning is needed', () => {
    expect(appendPromisedDiscordActionWithoutExecutionNotice('I have not started yet.', 0, 0)).toBe('I have not started yet.');
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
    const out = buildUnavailableActionTypesNotice(['taskSync', 'taskSync', 'channelCreate']);
    expect(out).toContain('Ignored unavailable action types:');
    expect(out).toContain('`taskSync`');
    expect(out).toContain('`channelCreate`');
  });

  it('renders specific enable-guidance for a known-disabled type (generateImage)', () => {
    const out = buildUnavailableActionTypesNotice(['generateImage']);
    expect(out).toContain('Setup walkthrough');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1');
    expect(out).toContain('instance `.env` file');
    expect(out).toContain('OPENAI_API_KEY');
    expect(out).toContain('IMAGEGEN_GEMINI_API_KEY');
    expect(out).toContain('IMAGEGEN_DEFAULT_MODEL');
    expect(out).toContain('`!restart`');
    expect(out).toContain('`generateImage`');
    expect(out).not.toContain('unknown type or category disabled');
  });

  it('renders imagegen guidance as a concrete setup checklist', () => {
    const out = buildUnavailableActionTypesNotice(['generateImage']);
    expect(out).toContain('1. Open the instance `.env` file used by this bot.');
    expect(out).toContain('2. Set `DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1`.');
    expect(out).toContain('3. Configure one provider: set `OPENAI_API_KEY`');
    expect(out).toContain('5. Reload the bot with `!restart`, then retry the image request.');
  });

  it('groups multiple types sharing the same help text onto one line', () => {
    const out = buildUnavailableActionTypesNotice(['ban', 'kick']);
    expect(out).toContain('`ban`');
    expect(out).toContain('`kick`');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_MODERATION=1');
    // The guidance should appear only once, not duplicated
    const occurrences = (out.match(/DISCOCLAW_DISCORD_ACTIONS_MODERATION=1/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('renders both specific guidance and generic fallback for a mix of known and unknown types', () => {
    const out = buildUnavailableActionTypesNotice(['generateImage', 'channelCreate']);
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1');
    expect(out).toContain('`generateImage`');
    expect(out).toContain('`channelCreate`');
    expect(out).toContain('unknown type or category disabled');
  });

  it('renders specific guidance for the defer type', () => {
    const out = buildUnavailableActionTypesNotice(['defer']);
    expect(out).toContain('`defer`');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_DEFER=1');
    expect(out).not.toContain('unknown type or category disabled');
  });

  it('renders botProfile enable-guidance for botSetStatus, botSetActivity, and botSetNickname', () => {
    const out = buildUnavailableActionTypesNotice(['botSetStatus', 'botSetActivity', 'botSetNickname']);
    expect(out).toContain('`botSetStatus`');
    expect(out).toContain('`botSetActivity`');
    expect(out).toContain('`botSetNickname`');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE=1');
    // All three share the same help text — guidance should appear only once
    const occurrences = (out.match(/DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE=1/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(out).not.toContain('unknown type or category disabled');
  });

  it('renders forge enable-guidance for all forge action types', () => {
    const out = buildUnavailableActionTypesNotice(['forgeCreate', 'forgeResume', 'forgeStatus', 'forgeCancel']);
    expect(out).toContain('`forgeCreate`');
    expect(out).toContain('`forgeResume`');
    expect(out).toContain('`forgeStatus`');
    expect(out).toContain('`forgeCancel`');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_FORGE=1');
    expect(out).toContain('DISCOCLAW_FORGE_COMMANDS_ENABLED=1');
    // All four share the same help text — guidance should appear only once
    const occurrences = (out.match(/DISCOCLAW_DISCORD_ACTIONS_FORGE=1/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(out).not.toContain('unknown type or category disabled');
  });

  it('renders plan enable-guidance for all plan action types', () => {
    const out = buildUnavailableActionTypesNotice(['planList', 'planShow', 'planApprove', 'planClose', 'planCreate', 'planRun']);
    expect(out).toContain('`planList`');
    expect(out).toContain('`planRun`');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_PLAN=1');
    expect(out).toContain('DISCOCLAW_PLAN_COMMANDS_ENABLED=1');
    // All six share the same help text — guidance should appear only once
    const occurrences = (out.match(/DISCOCLAW_DISCORD_ACTIONS_PLAN=1/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(out).not.toContain('unknown type or category disabled');
  });

  it('renders memory enable-guidance for all memory action types', () => {
    const out = buildUnavailableActionTypesNotice(['memoryRemember', 'memoryForget', 'memoryShow']);
    expect(out).toContain('`memoryRemember`');
    expect(out).toContain('`memoryForget`');
    expect(out).toContain('`memoryShow`');
    expect(out).toContain('DISCOCLAW_DISCORD_ACTIONS_MEMORY=1');
    expect(out).toContain('DISCOCLAW_DURABLE_MEMORY_ENABLED=1');
    // All three share the same help text — guidance should appear only once
    const occurrences = (out.match(/DISCOCLAW_DISCORD_ACTIONS_MEMORY=1/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(out).not.toContain('unknown type or category disabled');
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

describe('buildParseFailureNotice', () => {
  it('returns empty string for zero failures', () => {
    expect(buildParseFailureNotice(0)).toBe('');
  });

  it('returns empty string for negative count', () => {
    expect(buildParseFailureNotice(-1)).toBe('');
  });

  it('returns singular warning for one failure', () => {
    const out = buildParseFailureNotice(1);
    expect(out).toContain('1 action block');
    expect(out).toContain('malformed JSON');
    expect(out).toContain('skipped');
  });

  it('returns plural warning for multiple failures', () => {
    const out = buildParseFailureNotice(3);
    expect(out).toContain('3 action blocks');
    expect(out).toContain('malformed JSON');
    expect(out).toContain('skipped');
  });
});

describe('appendParseFailureNotice', () => {
  it('appends the notice under existing text', () => {
    const out = appendParseFailureNotice('hello', 1);
    expect(out).toContain('hello');
    expect(out).toContain('malformed JSON');
    expect(out.indexOf('hello')).toBeLessThan(out.indexOf('malformed JSON'));
  });

  it('returns notice alone when base text is empty', () => {
    const out = appendParseFailureNotice('', 2);
    expect(out).toContain('2 action blocks');
    expect(out.startsWith('Warning:')).toBe(true);
  });

  it('returns original text when count is zero', () => {
    expect(appendParseFailureNotice('hello', 0)).toBe('hello');
  });
});
