import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveMediaType, downloadAttachment, downloadMessageImages,
  sniffMediaType,
  MIN_PNG_BYTES, MIN_JPEG_BYTES, MIN_GIF_BYTES, MIN_WEBP_BYTES,
  type AttachmentLike,
} from './image-download.js';

// --- Helper buffers with valid magic bytes ---

/** PNG: 8-byte signature padded to >= MIN_PNG_BYTES */
function makePngBuffer(size: number = MIN_PNG_BYTES): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(buf);
  return buf;
}

/** JPEG: FF D8 FF E0 padded to >= MIN_JPEG_BYTES */
function makeJpegBuffer(size: number = MIN_JPEG_BYTES): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).copy(buf);
  return buf;
}

/** GIF89a padded to >= MIN_GIF_BYTES */
function makeGifBuffer(size: number = MIN_GIF_BYTES): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).copy(buf);
  return buf;
}

/** WebP: RIFF....WEBP padded to >= MIN_WEBP_BYTES */
function makeWebpBuffer(size: number = MIN_WEBP_BYTES): Buffer {
  const buf = Buffer.alloc(size);
  Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(buf, 0);
  Buffer.from([0x57, 0x45, 0x42, 0x50]).copy(buf, 8);
  return buf;
}

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

describe('sniffMediaType', () => {
  it('detects PNG from 8-byte signature', () => {
    expect(sniffMediaType(makePngBuffer())).toBe('image/png');
  });

  it('detects JPEG from FF D8 FF (JFIF)', () => {
    expect(sniffMediaType(makeJpegBuffer())).toBe('image/jpeg');
  });

  it('detects JPEG from FF D8 FF E1 (EXIF)', () => {
    const buf = Buffer.alloc(20);
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]).copy(buf);
    expect(sniffMediaType(buf)).toBe('image/jpeg');
  });

  it('detects GIF89a', () => {
    expect(sniffMediaType(makeGifBuffer())).toBe('image/gif');
  });

  it('detects GIF87a', () => {
    const buf = Buffer.alloc(26);
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]).copy(buf);
    expect(sniffMediaType(buf)).toBe('image/gif');
  });

  it('detects WebP from RIFF...WEBP', () => {
    expect(sniffMediaType(makeWebpBuffer())).toBe('image/webp');
  });

  it('returns null for empty buffer', () => {
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for random bytes', () => {
    expect(sniffMediaType(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))).toBeNull();
  });

  it('returns null for 1-byte buffer', () => {
    expect(sniffMediaType(Buffer.from([0xFF]))).toBeNull();
  });

  it('returns null for 2-byte buffer', () => {
    expect(sniffMediaType(Buffer.from([0xFF, 0xD8]))).toBeNull();
  });

  it('returns null for 7-byte buffer matching PNG prefix', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A]);
    expect(sniffMediaType(buf)).toBeNull();
  });

  it('returns null for 5-byte buffer matching GIF prefix', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39]);
    expect(sniffMediaType(buf)).toBeNull();
  });

  it('returns null for RIFF + WAVE (not WebP)', () => {
    const buf = Buffer.alloc(12);
    Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(buf, 0);
    Buffer.from([0x57, 0x41, 0x56, 0x45]).copy(buf, 8); // WAVE, not WEBP
    expect(sniffMediaType(buf)).toBeNull();
  });

  it('returns null for 11-byte WebP-like buffer', () => {
    const buf = Buffer.alloc(11);
    Buffer.from([0x52, 0x49, 0x46, 0x46]).copy(buf, 0);
    // Too short to check offset 8-11
    expect(sniffMediaType(buf)).toBeNull();
  });

  it('detects format at exact minimum signature lengths', () => {
    expect(sniffMediaType(makePngBuffer(8))).toBe('image/png');
    expect(sniffMediaType(makeJpegBuffer(3))).toBe('image/jpeg');
    expect(sniffMediaType(makeGifBuffer(6))).toBe('image/gif');
    expect(sniffMediaType(makeWebpBuffer(12))).toBe('image/webp');
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
    const data = makePngBuffer();
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
      expect(result.image.base64).toBe(data.toString('base64'));
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

  it('rejects zero-byte image (unrecognized magic bytes)', async () => {
    const data = Buffer.alloc(0);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/empty.png', name: 'empty.png', size: 0 },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('unsupported image format');
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

  it('overrides declared MIME when magic bytes differ', async () => {
    // Declare image/webp but send JPEG bytes
    const data = makeJpegBuffer();
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/photo.webp', name: 'photo.webp', size: data.length },
      'image/webp',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image.mediaType).toBe('image/jpeg');
    }
  });

  it('rejects unsupported format (random bytes)', async () => {
    const data = Buffer.alloc(64, 0x42);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/mystery.png', name: 'mystery.png', size: data.length },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('unsupported image format');
    }
  });

  it('rejects truncated PNG (7 bytes, incomplete signature)', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A]);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/trunc.png', name: 'trunc.png', size: data.length },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsupported image format');
  });

  it('rejects header-only JPEG (3 bytes, below MIN_JPEG_BYTES)', async () => {
    const data = Buffer.from([0xFF, 0xD8, 0xFF]);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/tiny.jpg', name: 'tiny.jpg', size: data.length },
      'image/jpeg',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('image too small');
  });

  it('rejects header-only PNG (8 bytes, below MIN_PNG_BYTES)', async () => {
    const data = makePngBuffer(8);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/tiny.png', name: 'tiny.png', size: data.length },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('image too small');
  });

  it('accepts GIF at exactly MIN_GIF_BYTES', async () => {
    const data = makeGifBuffer(MIN_GIF_BYTES);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/tiny.gif', name: 'tiny.gif', size: data.length },
      'image/gif',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mediaType).toBe('image/gif');
  });

  it('rejects GIF at MIN_GIF_BYTES - 1', async () => {
    const data = makeGifBuffer(MIN_GIF_BYTES - 1);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/tiny.gif', name: 'tiny.gif', size: data.length },
      'image/gif',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('image too small');
  });

  it('accepts PNG at exactly MIN_PNG_BYTES', async () => {
    const data = makePngBuffer(MIN_PNG_BYTES);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/min.png', name: 'min.png', size: data.length },
      'image/png',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mediaType).toBe('image/png');
  });

  it('rejects PNG at MIN_PNG_BYTES - 1', async () => {
    const data = makePngBuffer(MIN_PNG_BYTES - 1);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/almost.png', name: 'almost.png', size: data.length },
      'image/png',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('image too small');
  });

  it('accepts WebP at exactly MIN_WEBP_BYTES', async () => {
    const data = makeWebpBuffer(MIN_WEBP_BYTES);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/min.webp', name: 'min.webp', size: data.length },
      'image/webp',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mediaType).toBe('image/webp');
  });

  it('rejects WebP at MIN_WEBP_BYTES - 1', async () => {
    const data = makeWebpBuffer(MIN_WEBP_BYTES - 1);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/almost.webp', name: 'almost.webp', size: data.length },
      'image/webp',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('image too small');
  });

  it('accepts JPEG at exactly MIN_JPEG_BYTES', async () => {
    const data = makeJpegBuffer(MIN_JPEG_BYTES);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/min.jpg', name: 'min.jpg', size: data.length },
      'image/jpeg',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mediaType).toBe('image/jpeg');
  });

  it('rejects JPEG at MIN_JPEG_BYTES - 1', async () => {
    const data = makeJpegBuffer(MIN_JPEG_BYTES - 1);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const result = await downloadAttachment(
      { url: 'https://cdn.discordapp.com/attachments/123/456/almost.jpg', name: 'almost.jpg', size: data.length },
      'image/jpeg',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('image too small');
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
    const pngData = makePngBuffer();
    const jpegData = makeJpegBuffer();
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(pngData.buffer.slice(pngData.byteOffset, pngData.byteOffset + pngData.byteLength)),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(jpegData.buffer.slice(jpegData.byteOffset, jpegData.byteOffset + jpegData.byteLength)),
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
    const pngData = makePngBuffer();
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(pngData.buffer.slice(pngData.byteOffset, pngData.byteOffset + pngData.byteLength)),
    });

    const result = await downloadMessageImages([
      makeAttachment('a.png', 'image/png', 100),
      makeAttachment('doc.pdf', 'application/pdf', 500),
      makeAttachment('b.jpg', 'image/jpeg', 200),
    ]);

    // Both images download, but magic bytes are PNG for both (single mock).
    // The important assertion is that the PDF was filtered out.
    expect(result.images).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('respects maxImages cap', async () => {
    const data = makePngBuffer();
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
    });

    const atts = Array.from({ length: 5 }, (_, i) => makeAttachment(`img${i}.png`, 'image/png', 100));
    const result = await downloadMessageImages(atts, 2);

    expect(result.images).toHaveLength(2);
  });

  it('stops downloading when total byte cap is exceeded', async () => {
    const data = makePngBuffer();
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
    const data = makePngBuffer();
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
    const data = makePngBuffer();
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
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
