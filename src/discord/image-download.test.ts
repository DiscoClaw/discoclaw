import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveMediaType, downloadAttachment, downloadMessageImages, isTextAttachment, downloadTextAttachment, downloadMessageTextFiles, type AttachmentLike } from './image-download.js';

describe('resolveMediaType', () => {
  it('returns MIME from contentType for PNG', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png' })).toBe('image/png');
  });

  it('returns MIME from contentType for JPEG', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.jpg', contentType: 'image/jpeg' })).toBe('image/jpeg');
  });

  it('returns MIME from contentType for WebP', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.webp', contentType: 'image/webp' })).toBe('image/webp');
  });

  it('returns MIME from contentType for GIF', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.gif', contentType: 'image/gif' })).toBe('image/gif');
  });

  it('strips charset from contentType', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png; charset=utf-8' })).toBe('image/png');
  });

  it('falls back to extension when contentType is missing', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.png', name: 'photo.png' })).toBe('image/png');
  });

  it('falls back to extension for jpg', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.jpg', name: 'photo.jpg' })).toBe('image/jpeg');
  });

  it('falls back to extension for jpeg', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.jpeg', name: 'photo.jpeg' })).toBe('image/jpeg');
  });

  it('returns null for unsupported contentType', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.pdf', contentType: 'application/pdf' })).toBeNull();
  });

  it('returns null for unsupported extension', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.pdf', name: 'doc.pdf' })).toBeNull();
  });

  it('returns null when no contentType or name', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a' })).toBeNull();
  });

  it('handles uppercase MIME types', () => {
    expect(resolveMediaType({ url: 'https://cdn.discordapp.com/a.png', contentType: 'IMAGE/PNG' })).toBe('image/png');
  });
});

describe('downloadAttachment', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads and base64-encodes a valid image', async () => {
    const data = Buffer.from('fake-png-data');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/photo.png', name: 'photo.png', size: data.length },
      'image/png',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image.mediaType).toBe('image/png');
      expect(Buffer.from(result.image.base64, 'base64').toString()).toBe('fake-png-data');
    }
  });

  it('rejects non-Discord-CDN URLs (SSRF protection)', async () => {
    const result = await downloadAttachment(
      { url: 'https://evil.com/malicious.png', name: 'malicious.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('blocked');
      expect(result.error).not.toContain('evil.com'); // no raw URL
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects HTTP URLs (non-HTTPS)', async () => {
    const result = await downloadAttachment(
      { url: 'http://cdn.discordapp.com/photo.png', name: 'photo.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized images from Discord metadata pre-check', async () => {
    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/photo.png', name: 'photo.png', size: 25 * 1024 * 1024 },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('too large');
      expect(result.error).toContain('max 20 MB');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized images after download', async () => {
    const bigBuf = Buffer.alloc(21 * 1024 * 1024); // 21 MB
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(bigBuf.buffer.slice(bigBuf.byteOffset, bigBuf.byteOffset + bigBuf.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/photo.png', name: 'photo.png', size: 100 }, // size lies
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('too large');
  });

  it('handles HTTP error responses', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 404 });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/photo.png', name: 'photo.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('HTTP 404');
  });

  it('handles network errors', async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/photo.png', name: 'photo.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('download failed');
  });

  it('handles timeout', async () => {
    const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
    (globalThis.fetch as any).mockRejectedValue(timeoutErr);

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/photo.png', name: 'photo.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
  });

  it('handles invalid URL', async () => {
    const result = await downloadAttachment(
      { url: 'not-a-url', name: 'bad.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid URL');
  });

  it('rejects redirected responses', async () => {
    const redirectErr = new TypeError('fetch failed: redirect mode is set to error');
    (globalThis.fetch as any).mockRejectedValue(redirectErr);

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/photo.png', name: 'photo.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('blocked (unexpected redirect)');
  });

  it('handles zero-byte image', async () => {
    const data = Buffer.alloc(0);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/empty.png', name: 'empty.png', size: 0 },
      'image/png',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image.base64).toBe('');
      expect(result.image.mediaType).toBe('image/png');
    }
  });

  it('error messages are sanitized — no raw URLs', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500 });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/photo.png?token=secret', name: 'photo.png' },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('secret');
      expect(result.error).not.toContain('https://');
    }
  });
});

describe('downloadMessageImages', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeAttachment(name: string, contentType: string, size: number): AttachmentLike {
    return { url: `https://cdn.discordapp.com/attachments/123/456/${name}`, name, contentType, size };
  }

  it('downloads multiple image attachments', async () => {
    const data = Buffer.from('img');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadMessageImages([
      makeAttachment('a.png', 'image/png', 100),
      makeAttachment('b.jpg', 'image/jpeg', 200),
    ]);

    expect(result.images).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.images[0].mediaType).toBe('image/png');
    expect(result.images[1].mediaType).toBe('image/jpeg');
  });

  it('filters out non-image attachments silently', async () => {
    const data = Buffer.from('img');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadMessageImages([
      makeAttachment('a.png', 'image/png', 100),
      makeAttachment('doc.pdf', 'application/pdf', 500),
      makeAttachment('b.jpg', 'image/jpeg', 200),
    ]);

    expect(result.images).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('respects maxImages cap', async () => {
    const data = Buffer.from('img');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const atts = Array.from({ length: 5 }, (_, i) => makeAttachment(`img${i}.png`, 'image/png', 100));
    const result = await downloadMessageImages(atts, 2);

    expect(result.images).toHaveLength(2);
  });

  it('stops downloading when total byte cap is exceeded', async () => {
    const data = Buffer.from('img');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadMessageImages([
      makeAttachment('a.png', 'image/png', 18 * 1024 * 1024), // 18 MB (under per-image 20 MB limit)
      makeAttachment('b.png', 'image/png', 18 * 1024 * 1024), // 18 MB (total 36 MB, ok)
      makeAttachment('c.png', 'image/png', 18 * 1024 * 1024), // 18 MB — total would be 54 MB, exceeds 50 MB cap
    ]);

    // First two images download, third is skipped.
    expect(result.images).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('total size limit');
  });

  it('returns empty for empty input', async () => {
    const result = await downloadMessageImages([]);
    expect(result.images).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects single attachment exceeding total byte cap', async () => {
    const data = Buffer.from('img');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadMessageImages([
      makeAttachment('huge.png', 'image/png', 60 * 1024 * 1024), // 60 MB — exceeds 50 MB total cap
    ]);

    expect(result.images).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('total size limit');
  });

  it('collects errors from individual failed downloads', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('ok').buffer),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await downloadMessageImages([
      makeAttachment('good.png', 'image/png', 100),
      makeAttachment('bad.png', 'image/png', 100),
    ]);

    expect(result.images).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('HTTP 500');
  });
});

// ---------------------------------------------------------------------------
// Text file attachment tests
// ---------------------------------------------------------------------------

describe('isTextAttachment', () => {
  it('returns true for .txt files', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.txt', name: 'notes.txt' })).toBe(true);
  });

  it('returns true for .py files', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.py', name: 'script.py' })).toBe(true);
  });

  it('returns true for .json files', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.json', name: 'data.json' })).toBe(true);
  });

  it('returns true for .md files', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.md', name: 'README.md' })).toBe(true);
  });

  it('returns true for text/ MIME type', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a', name: 'a', contentType: 'text/plain' })).toBe(true);
  });

  it('returns true for application/json MIME type', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a', name: 'a', contentType: 'application/json' })).toBe(true);
  });

  it('returns false for .png images', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.png', name: 'photo.png', contentType: 'image/png' })).toBe(false);
  });

  it('returns false for .zip files', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.zip', name: 'archive.zip', contentType: 'application/zip' })).toBe(false);
  });

  it('returns false for unknown extension and no MIME', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a.xyz', name: 'unknown.xyz' })).toBe(false);
  });

  it('returns false for attachments with no name or contentType', () => {
    expect(isTextAttachment({ url: 'https://cdn.discordapp.com/a' })).toBe(false);
  });
});

describe('downloadTextAttachment', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads and returns text content', async () => {
    const content = 'Hello, world!';
    const data = Buffer.from(content);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadTextAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/notes.txt', name: 'notes.txt', size: data.length },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.name).toBe('notes.txt');
      expect(result.file.content).toBe('Hello, world!');
    }
  });

  it('rejects non-Discord-CDN URLs (SSRF protection)', async () => {
    const result = await downloadTextAttachment(
      { url: 'https://evil.com/malicious.txt', name: 'malicious.txt' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('blocked');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects files exceeding size limit from metadata', async () => {
    const result = await downloadTextAttachment(
      { url: 'https://cdn.discordapp.com/notes.txt', name: 'notes.txt', size: 200 * 1024 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('too large');
      expect(result.error).toContain('max 100 KB');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects files exceeding size limit after download', async () => {
    const bigBuf = Buffer.alloc(150 * 1024);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(bigBuf.buffer.slice(bigBuf.byteOffset, bigBuf.byteOffset + bigBuf.byteLength)),
    });

    const result = await downloadTextAttachment(
      { url: 'https://cdn.discordapp.com/notes.txt', name: 'notes.txt', size: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('too large');
  });

  it('handles timeout', async () => {
    const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
    (globalThis.fetch as any).mockRejectedValue(timeoutErr);

    const result = await downloadTextAttachment(
      { url: 'https://cdn.discordapp.com/notes.txt', name: 'notes.txt' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
  });

  it('handles HTTP error responses', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 403 });

    const result = await downloadTextAttachment(
      { url: 'https://cdn.discordapp.com/notes.txt', name: 'notes.txt' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('HTTP 403');
  });
});

describe('downloadMessageTextFiles', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeAttachment(name: string, contentType: string | null, size: number): AttachmentLike {
    return { url: `https://cdn.discordapp.com/attachments/123/456/${name}`, name, contentType, size };
  }

  function mockTextFetch(content: string) {
    const data = Buffer.from(content);
    return {
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    };
  }

  it('downloads multiple text files', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(mockTextFetch('file one'))
      .mockResolvedValueOnce(mockTextFetch('file two'));

    const result = await downloadMessageTextFiles([
      makeAttachment('a.txt', 'text/plain', 100),
      makeAttachment('b.py', null, 200),
    ]);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].name).toBe('a.txt');
    expect(result.files[0].content).toBe('file one');
    expect(result.files[1].name).toBe('b.py');
    expect(result.urls).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('filters out images and collects binary URLs', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(mockTextFetch('text content'));

    const result = await downloadMessageTextFiles([
      makeAttachment('photo.png', 'image/png', 100),    // image — skipped
      makeAttachment('notes.txt', 'text/plain', 50),     // text — inlined
      makeAttachment('archive.zip', 'application/zip', 500), // binary — URL collected
    ]);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('notes.txt');
    expect(result.urls).toHaveLength(1);
    expect(result.urls[0]).toContain('archive.zip');
    expect(result.errors).toHaveLength(0);
  });

  it('respects max text files cap', async () => {
    (globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve(mockTextFetch('content')),
    );

    const atts = Array.from({ length: 7 }, (_, i) =>
      makeAttachment(`file${i}.txt`, 'text/plain', 50),
    );
    const result = await downloadMessageTextFiles(atts);

    // Only first 5 files downloaded; remaining 2 reported as errors with URLs.
    expect(result.files).toHaveLength(5);
    expect(result.errors).toHaveLength(2);
    expect(result.urls).toHaveLength(2);
  });

  it('respects total byte budget', async () => {
    (globalThis.fetch as any).mockImplementation(() =>
      Promise.resolve(mockTextFetch('x')),
    );

    // First file (95 KB) fits both per-file and total budget.
    // Second file (410 KB) would push total to 505 KB > 500 KB cap.
    const result = await downloadMessageTextFiles([
      makeAttachment('a.txt', 'text/plain', 95 * 1024),
      makeAttachment('b.txt', 'text/plain', 410 * 1024),
    ]);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('a.txt');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('total text size limit');
    expect(result.urls).toHaveLength(1);
  });

  it('returns empty for empty input', async () => {
    const result = await downloadMessageTextFiles([]);
    expect(result.files).toHaveLength(0);
    expect(result.urls).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('falls back to URL when download fails', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500 });

    const result = await downloadMessageTextFiles([
      makeAttachment('broken.txt', 'text/plain', 50),
    ]);

    expect(result.files).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('HTTP 500');
    expect(result.urls).toHaveLength(1);
  });
});
