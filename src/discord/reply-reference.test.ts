import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveReplyReference } from './reply-reference.js';
import type { MessageWithReference, ReferencedMessage } from './reply-reference.js';

function makeMsg(opts: {
  refId?: string;
  refAuthor?: { id?: string; bot?: boolean; displayName?: string; username: string };
  refContent?: string;
  refAttachments?: Map<string, any>;
  refEmbeds?: Array<{ title?: string | null; url?: string | null }>;
  fetchFails?: boolean;
}): MessageWithReference {
  const refMsg: ReferencedMessage = {
    author: opts.refAuthor ?? { id: '456', username: 'TestUser', displayName: 'Test User' },
    content: opts.refContent ?? 'hello world',
    attachments: opts.refAttachments ?? new Map(),
    embeds: opts.refEmbeds ?? [],
  };

  return {
    reference: opts.refId ? { messageId: opts.refId } : null,
    channel: {
      messages: {
        fetch: opts.fetchFails
          ? vi.fn().mockRejectedValue(new Error('Unknown Message'))
          : vi.fn().mockResolvedValue(refMsg),
      },
    },
  };
}

describe('resolveReplyReference', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when no reference', async () => {
    const msg = makeMsg({});
    expect(await resolveReplyReference(msg, 'Weston')).toBeNull();
  });

  it('returns section with author and content', async () => {
    const msg = makeMsg({ refId: '999', refContent: 'check this out' });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result).not.toBeNull();
    expect(result!.section).toContain('[Test User (ID: 456)]: check this out');
    expect(result!.images).toHaveLength(0);
  });

  it('uses botDisplayName for bot authors', async () => {
    const msg = makeMsg({
      refId: '999',
      refAuthor: { id: '789', bot: true, username: 'discoclaw', displayName: 'Discoclaw' },
      refContent: 'I said something',
    });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('[Weston (ID: 789)]: I said something');
  });

  it('falls back to Discoclaw when botDisplayName is undefined', async () => {
    const msg = makeMsg({
      refId: '999',
      refAuthor: { id: '789', bot: true, username: 'discoclaw' },
      refContent: 'bot message',
    });
    const result = await resolveReplyReference(msg, undefined);

    expect(result!.section).toContain('[Discoclaw (ID: 789)]: bot message');
  });

  it('uses username when displayName is empty', async () => {
    const msg = makeMsg({
      refId: '999',
      refAuthor: { id: '111', username: 'dave123', displayName: '' },
      refContent: 'yo',
    });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('[dave123 (ID: 111)]: yo');
  });

  it('notes unsupported attachments inline', async () => {
    const atts = new Map([
      ['1', { url: 'https://cdn.discordapp.com/a.pdf', name: 'report.pdf', contentType: 'application/pdf', size: 100 }],
    ]);
    const msg = makeMsg({ refId: '999', refContent: 'see attached', refAttachments: atts });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('Unsupported attachment: report.pdf');
    expect(result!.images).toHaveLength(0);
    expect(result!.files).toHaveLength(0);
  });

  it('downloads text file attachments from referenced message', async () => {
    const fileContent = 'console.log("hello world");';
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(fileContent).buffer),
    });

    const atts = new Map([
      ['1', { url: 'https://cdn.discordapp.com/attachments/1/2/script.js', name: 'script.js', contentType: 'application/javascript', size: 27 }],
    ]);
    const msg = makeMsg({ refId: '999', refContent: 'check this code', refAttachments: atts });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.files).toHaveLength(1);
    expect(result!.files[0].name).toBe('script.js');
    expect(result!.files[0].content).toBe(fileContent);
    expect(result!.section).toContain('[Attached file: script.js]');
    expect(result!.section).toContain(fileContent);
  });

  it('downloads image attachments from referenced message', async () => {
    const imgData = Buffer.from('fake-png');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imgData.buffer.slice(imgData.byteOffset, imgData.byteOffset + imgData.byteLength)),
    });

    const atts = new Map([
      ['1', { url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', name: 'photo.png', contentType: 'image/png', size: 100 }],
    ]);
    const msg = makeMsg({ refId: '999', refContent: 'look at this', refAttachments: atts });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.images).toHaveLength(1);
    expect(result!.images[0].mediaType).toBe('image/png');
  });

  it('respects shared image budget', async () => {
    const imgData = Buffer.from('fake-png');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imgData.buffer.slice(imgData.byteOffset, imgData.byteOffset + imgData.byteLength)),
    });

    const atts = new Map([
      ['1', { url: 'https://cdn.discordapp.com/attachments/1/2/a.png', name: 'a.png', contentType: 'image/png', size: 100 }],
      ['2', { url: 'https://cdn.discordapp.com/attachments/1/2/b.png', name: 'b.png', contentType: 'image/png', size: 100 }],
    ]);
    const msg = makeMsg({ refId: '999', refContent: 'images', refAttachments: atts });

    // Budget already has 9 used, only 1 remaining
    const result = await resolveReplyReference(msg, 'Weston', undefined, 9);

    expect(result!.images).toHaveLength(1);
  });

  it('skips images when budget is exhausted', async () => {
    const atts = new Map([
      ['1', { url: 'https://cdn.discordapp.com/attachments/1/2/a.png', name: 'a.png', contentType: 'image/png', size: 100 }],
    ]);
    const msg = makeMsg({ refId: '999', refContent: 'no budget', refAttachments: atts });

    const result = await resolveReplyReference(msg, 'Weston', undefined, 10);

    expect(result!.images).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns null on fetch failure (deleted message)', async () => {
    const msg = makeMsg({ refId: '999', fetchFails: true });
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const result = await resolveReplyReference(msg, 'Weston', log);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it('handles empty content gracefully', async () => {
    const msg = makeMsg({ refId: '999', refContent: '' });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('[Test User (ID: 456)]: ');
  });

  it('truncates long content with ellipsis', async () => {
    const longContent = 'x'.repeat(2000);
    const msg = makeMsg({ refId: '999', refContent: longContent });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('x'.repeat(1500) + '…');
    expect(result!.section).not.toContain('x'.repeat(1501));
  });

  it('includes embed info in section', async () => {
    const msg = makeMsg({
      refId: '999',
      refContent: 'check this link',
      refEmbeds: [
        { title: 'Article Title', url: 'https://example.com' },
        { title: 'Another', url: null },
      ],
    });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('Embeds: Article Title https://example.com, Another');
  });

  it('skips embeds with no title or url', async () => {
    const msg = makeMsg({
      refId: '999',
      refContent: 'empty embed',
      refEmbeds: [
        { title: null, url: null },
        { title: 'Valid', url: 'https://example.com' },
      ],
    });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('Embeds: Valid https://example.com');
    expect(result!.section).not.toContain('null');
  });

  it('notes image count in section when images are present', async () => {
    const imgData = Buffer.from('fake-png');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(imgData.buffer.slice(imgData.byteOffset, imgData.byteOffset + imgData.byteLength)),
    });

    const atts = new Map([
      ['1', { url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', name: 'photo.png', contentType: 'image/png', size: 100 }],
    ]);
    const msg = makeMsg({ refId: '999', refContent: 'see image', refAttachments: atts });
    const result = await resolveReplyReference(msg, 'Weston');

    expect(result!.section).toContain('1 image(s) from replied-to message included below');
  });
});
