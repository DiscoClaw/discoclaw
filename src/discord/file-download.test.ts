import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveTextType, isTextType, classifyAttachments, downloadTextAttachments } from './file-download.js';
import type { AttachmentLike } from './image-download.js';

function makeAtt(name: string, contentType: string | null, size: number = 100): AttachmentLike {
  return { url: `https://cdn.discordapp.com/attachments/1/2/${name}`, name, contentType, size };
}

describe('resolveTextType', () => {
  it('returns MIME for text/plain', () => {
    expect(resolveTextType(makeAtt('a.txt', 'text/plain'))).toBe('text/plain');
  });

  it('returns MIME for application/json', () => {
    expect(resolveTextType(makeAtt('a.json', 'application/json'))).toBe('application/json');
  });

  it('returns MIME for text/csv', () => {
    expect(resolveTextType(makeAtt('a.csv', 'text/csv'))).toBe('text/csv');
  });

  it('strips charset from contentType', () => {
    expect(resolveTextType(makeAtt('a.txt', 'text/plain; charset=utf-8'))).toBe('text/plain');
  });

  it('falls back to extension for .json', () => {
    expect(resolveTextType(makeAtt('config.json', null))).toBe('application/json');
  });

  it('falls back to extension for .md', () => {
    expect(resolveTextType(makeAtt('README.md', null))).toBe('text/markdown');
  });

  it('falls back to extension for .py', () => {
    expect(resolveTextType(makeAtt('script.py', null))).toBe('text/x-script');
  });

  it('falls back to extension for .yml', () => {
    expect(resolveTextType(makeAtt('config.yml', null))).toBe('text/yaml');
  });

  it('falls back to extension for .yaml', () => {
    expect(resolveTextType(makeAtt('config.yaml', null))).toBe('text/yaml');
  });

  it('falls back to extension for .sh', () => {
    expect(resolveTextType(makeAtt('build.sh', null))).toBe('text/x-script');
  });

  it('returns null for image types', () => {
    expect(resolveTextType(makeAtt('photo.png', 'image/png'))).toBeNull();
  });

  it('returns null for PDF', () => {
    expect(resolveTextType(makeAtt('doc.pdf', 'application/pdf'))).toBeNull();
  });

  it('returns null for unknown extension and no contentType', () => {
    expect(resolveTextType(makeAtt('data.xyz', null))).toBeNull();
  });
});

describe('isTextType', () => {
  it('returns true for text/* types', () => {
    expect(isTextType('text/plain')).toBe(true);
    expect(isTextType('text/x-script')).toBe(true);
    expect(isTextType('text/csv')).toBe(true);
  });

  it('returns true for application text types', () => {
    expect(isTextType('application/json')).toBe(true);
    expect(isTextType('application/javascript')).toBe(true);
  });

  it('returns false for non-text types', () => {
    expect(isTextType('application/pdf')).toBe(false);
    expect(isTextType('image/png')).toBe(false);
  });
});

describe('classifyAttachments', () => {
  it('separates text from unsupported', () => {
    const atts = [
      makeAtt('code.js', 'application/javascript'),
      makeAtt('doc.pdf', 'application/pdf'),
      makeAtt('notes.txt', 'text/plain'),
    ];
    const { text, unsupported } = classifyAttachments(atts);

    expect(text).toHaveLength(2);
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].name).toBe('doc.pdf');
  });

  it('handles empty input', () => {
    const { text, unsupported } = classifyAttachments([]);
    expect(text).toHaveLength(0);
    expect(unsupported).toHaveLength(0);
  });
});

describe('downloadTextAttachments', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads text file content', async () => {
    const content = 'hello world';
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from(content)),
    });

    const result = await downloadTextAttachments([
      makeAtt('hello.txt', 'text/plain', 11),
    ]);

    expect(result.texts).toHaveLength(1);
    expect(result.texts[0].name).toBe('hello.txt');
    expect(result.texts[0].content).toBe('hello world');
    expect(result.errors).toHaveLength(0);
  });

  it('notes unsupported attachment types', async () => {
    const result = await downloadTextAttachments([
      makeAtt('doc.pdf', 'application/pdf', 100),
    ]);

    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Unsupported attachment');
    expect(result.errors[0]).toContain('doc.pdf');
    expect(result.errors[0]).toContain('application/pdf');
  });

  it('blocks non-Discord CDN URLs (SSRF)', async () => {
    const att: AttachmentLike = {
      url: 'https://evil.com/secret.txt',
      name: 'secret.txt',
      contentType: 'text/plain',
      size: 10,
    };

    const result = await downloadTextAttachments([att]);

    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('truncates files exceeding per-file size limit', async () => {
    const bigContent = 'A'.repeat(150 * 1024); // 150KB
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from(bigContent)),
    });

    const result = await downloadTextAttachments([
      makeAtt('big.txt', 'text/plain', 150 * 1024),
    ]);

    expect(result.texts).toHaveLength(1);
    expect(result.texts[0].content).toContain('[truncated at 100KB]');
    expect(result.texts[0].content.length).toBeLessThan(bigContent.length);
  });

  it('skips files when total budget is exceeded', async () => {
    const content = 'A'.repeat(150 * 1024); // 150KB each
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from(content)),
    });

    const result = await downloadTextAttachments([
      makeAtt('a.txt', 'text/plain', 150 * 1024),
      makeAtt('b.txt', 'text/plain', 150 * 1024), // would exceed 200KB total
    ]);

    expect(result.texts).toHaveLength(1);
    expect(result.errors.some(e => e.includes('total size limit'))).toBe(true);
  });

  it('handles HTTP errors', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 404 });

    const result = await downloadTextAttachments([
      makeAtt('missing.txt', 'text/plain', 10),
    ]);

    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('HTTP 404');
  });

  it('handles download timeout', async () => {
    const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
    (globalThis.fetch as any).mockRejectedValue(timeoutErr);

    const result = await downloadTextAttachments([
      makeAtt('slow.txt', 'text/plain', 10),
    ]);

    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('timed out');
  });

  it('rejects non-UTF8 content', async () => {
    // Create a buffer with invalid UTF-8 bytes
    const badBuffer = Buffer.from([0xff, 0xfe, 0x80, 0x81]);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(badBuffer.buffer.slice(badBuffer.byteOffset, badBuffer.byteOffset + badBuffer.byteLength)),
    });

    const result = await downloadTextAttachments([
      makeAtt('binary.txt', 'text/plain', 4),
    ]);

    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not valid UTF-8');
  });

  it('handles empty input', async () => {
    const result = await downloadTextAttachments([]);
    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('handles mix of text and unsupported files', async () => {
    const content = 'data';
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from(content)),
    });

    const result = await downloadTextAttachments([
      makeAtt('code.js', 'application/javascript', 4),
      makeAtt('archive.zip', 'application/zip', 1000),
      makeAtt('notes.md', null, 4), // extension fallback
    ]);

    expect(result.texts).toHaveLength(2); // code.js + notes.md
    expect(result.errors).toHaveLength(1); // archive.zip unsupported
    expect(result.errors[0]).toContain('archive.zip');
  });

  it('uses extension fallback when contentType is missing', async () => {
    const content = '{"key":"value"}';
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from(content)),
    });

    const result = await downloadTextAttachments([
      makeAtt('config.json', null, 15),
    ]);

    expect(result.texts).toHaveLength(1);
    expect(result.texts[0].content).toBe('{"key":"value"}');
  });
});
