import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveTextType, resolveDocumentType, isTextType, classifyAttachments, downloadTextAttachments, downloadDocumentAttachments } from './file-download.js';
import type { AttachmentLike } from './image-download.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

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

  // --- New extension tests ---
  it('falls back to extension for .go', () => {
    expect(resolveTextType(makeAtt('main.go', null))).toBe('text/x-script');
  });

  it('falls back to extension for .rs', () => {
    expect(resolveTextType(makeAtt('lib.rs', null))).toBe('text/x-script');
  });

  it('falls back to extension for .css', () => {
    expect(resolveTextType(makeAtt('styles.css', null))).toBe('text/css');
  });

  it('falls back to extension for .jsx', () => {
    expect(resolveTextType(makeAtt('App.jsx', null))).toBe('application/javascript');
  });

  it('falls back to extension for .tsx', () => {
    expect(resolveTextType(makeAtt('App.tsx', null))).toBe('application/typescript');
  });

  it('falls back to extension for .mjs', () => {
    expect(resolveTextType(makeAtt('index.mjs', null))).toBe('application/javascript');
  });

  it('falls back to extension for .mts', () => {
    expect(resolveTextType(makeAtt('index.mts', null))).toBe('application/typescript');
  });

  it('falls back to extension for .toml', () => {
    expect(resolveTextType(makeAtt('config.toml', null))).toBe('application/toml');
  });

  it('falls back to extension for .env', () => {
    expect(resolveTextType(makeAtt('app.env', null))).toBe('text/plain');
  });

  it('falls back to extension for .sql', () => {
    expect(resolveTextType(makeAtt('schema.sql', null))).toBe('application/sql');
  });

  it('falls back to extension for .tf', () => {
    expect(resolveTextType(makeAtt('main.tf', null))).toBe('text/plain');
  });

  it('falls back to extension for .proto', () => {
    expect(resolveTextType(makeAtt('service.proto', null))).toBe('text/plain');
  });

  it('falls back to extension for .jsonc', () => {
    expect(resolveTextType(makeAtt('tsconfig.jsonc', null))).toBe('application/json');
  });

  it('falls back to extension for .dockerfile', () => {
    expect(resolveTextType(makeAtt('app.dockerfile', null))).toBe('text/plain');
  });

  it('falls back to extension for .log', () => {
    expect(resolveTextType(makeAtt('error.log', null))).toBe('text/plain');
  });

  it('falls back to extension for .svg', () => {
    expect(resolveTextType(makeAtt('icon.svg', null))).toBe('text/xml');
  });

  it('falls back to extension for .astro', () => {
    expect(resolveTextType(makeAtt('Page.astro', null))).toBe('text/html');
  });

  it('falls back to extension for .bat', () => {
    expect(resolveTextType(makeAtt('build.bat', null))).toBe('text/x-script');
  });

  it('falls back to extension for .gd (GDScript)', () => {
    expect(resolveTextType(makeAtt('player.gd', null))).toBe('text/x-script');
  });

  // --- Bare dotfile tests (dotIdx === 0 path) ---
  it('resolves bare .env dotfile', () => {
    expect(resolveTextType(makeAtt('.env', null))).toBe('text/plain');
  });

  it('resolves bare .gitignore dotfile', () => {
    expect(resolveTextType(makeAtt('.gitignore', null))).toBe('text/plain');
  });

  it('resolves bare .prettierrc dotfile', () => {
    expect(resolveTextType(makeAtt('.prettierrc', null))).toBe('text/plain');
  });

  // --- Negative cases ---
  it('returns null for .exe (binary)', () => {
    expect(resolveTextType(makeAtt('app.exe', null))).toBeNull();
  });

  it('returns null for .dll (binary)', () => {
    expect(resolveTextType(makeAtt('lib.dll', null))).toBeNull();
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

  it('returns true for application/toml', () => {
    expect(isTextType('application/toml')).toBe(true);
  });

  it('returns true for application/sql', () => {
    expect(isTextType('application/sql')).toBe(true);
  });

  it('returns true for application/graphql', () => {
    expect(isTextType('application/graphql')).toBe(true);
  });

  it('returns true for text/css', () => {
    expect(isTextType('text/css')).toBe(true);
  });

  it('returns false for non-text types', () => {
    expect(isTextType('application/pdf')).toBe(false);
    expect(isTextType('image/png')).toBe(false);
  });
});

describe('classifyAttachments', () => {
  it('separates text, documents, and unsupported into three buckets', () => {
    const atts = [
      makeAtt('code.js', 'application/javascript'),
      makeAtt('doc.pdf', 'application/pdf'),
      makeAtt('notes.txt', 'text/plain'),
      makeAtt('archive.zip', 'application/zip'),
    ];
    const { text, documents, unsupported } = classifyAttachments(atts);

    expect(text).toHaveLength(2);
    expect(text.map(t => t.attachment.name)).toEqual(['code.js', 'notes.txt']);
    expect(documents).toHaveLength(1);
    expect(documents[0].attachment.name).toBe('doc.pdf');
    expect(documents[0].mime).toBe('application/pdf');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].name).toBe('archive.zip');
  });

  it('handles empty input', () => {
    const { text, documents, unsupported } = classifyAttachments([]);
    expect(text).toHaveLength(0);
    expect(documents).toHaveLength(0);
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
    expect(result.texts[0].content).toContain('[EXTERNAL CONTENT:');
    expect(result.texts[0].content).toContain('hello world');
    expect(result.errors).toHaveLength(0);
  });

  it('notes unsupported attachment types', async () => {
    const result = await downloadTextAttachments([
      makeAtt('archive.zip', 'application/zip', 100),
    ]);

    expect(result.texts).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Unsupported attachment');
    expect(result.errors[0]).toContain('archive.zip');
    expect(result.errors[0]).toContain('application/zip');
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
    expect(result.texts[0].content).toContain('[truncated]');
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
    expect(result.texts[0].content).toContain('[EXTERNAL CONTENT:');
    expect(result.texts[0].content).toContain('{"key":"value"}');
  });
});

describe('resolveDocumentType', () => {
  it('returns MIME for application/pdf', () => {
    expect(resolveDocumentType(makeAtt('doc.pdf', 'application/pdf'))).toBe('application/pdf');
  });

  it('falls back to extension for .pdf', () => {
    expect(resolveDocumentType(makeAtt('report.pdf', null))).toBe('application/pdf');
  });

  it('returns null for non-document types', () => {
    expect(resolveDocumentType(makeAtt('code.js', 'application/javascript'))).toBeNull();
    expect(resolveDocumentType(makeAtt('photo.png', 'image/png'))).toBeNull();
    expect(resolveDocumentType(makeAtt('data.xyz', null))).toBeNull();
  });
});

describe('downloadDocumentAttachments', () => {
  const originalFetch = globalThis.fetch;
  let mockWriteFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    globalThis.fetch = vi.fn();
    const fsMod = await import('node:fs/promises');
    mockWriteFile = fsMod.writeFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads PDF and writes to /tmp', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content');
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength)),
    });

    const docs = [{ attachment: makeAtt('report.pdf', 'application/pdf', 100), mime: 'application/pdf' }];
    const result = await downloadDocumentAttachments(docs, 'msg123');

    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].name).toBe('report.pdf');
    expect(result.docs[0].path).toBe('/tmp/discoclaw-doc-msg123-0.pdf');
    expect(result.errors).toHaveLength(0);
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/discoclaw-doc-msg123-0.pdf', expect.any(Buffer));
  });

  it('blocks non-Discord CDN URLs (SSRF)', async () => {
    const att: AttachmentLike = {
      url: 'https://evil.com/secret.pdf',
      name: 'secret.pdf',
      contentType: 'application/pdf',
      size: 10,
    };

    const result = await downloadDocumentAttachments(
      [{ attachment: att, mime: 'application/pdf' }],
      'msg456',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('blocked');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('blocks HTTP URLs', async () => {
    const att: AttachmentLike = {
      url: 'http://cdn.discordapp.com/attachments/1/2/doc.pdf',
      name: 'doc.pdf',
      contentType: 'application/pdf',
      size: 10,
    };

    const result = await downloadDocumentAttachments(
      [{ attachment: att, mime: 'application/pdf' }],
      'msg789',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors[0]).toContain('blocked');
  });

  it('rejects files exceeding 25 MB via metadata', async () => {
    const att = makeAtt('huge.pdf', 'application/pdf', 26 * 1024 * 1024);

    const result = await downloadDocumentAttachments(
      [{ attachment: att, mime: 'application/pdf' }],
      'msgBig',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('25 MB');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects files exceeding 25 MB after download', async () => {
    const bigBuf = Buffer.alloc(26 * 1024 * 1024);
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(bigBuf.buffer.slice(bigBuf.byteOffset, bigBuf.byteOffset + bigBuf.byteLength)),
    });

    // metadata size=0 so pre-check doesn't fire
    const att = makeAtt('huge.pdf', 'application/pdf', 0);
    const result = await downloadDocumentAttachments(
      [{ attachment: att, mime: 'application/pdf' }],
      'msgBig2',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors[0]).toContain('25 MB');
  });

  it('handles HTTP errors', async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 403 });

    const result = await downloadDocumentAttachments(
      [{ attachment: makeAtt('secret.pdf', 'application/pdf', 100), mime: 'application/pdf' }],
      'msgErr',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors[0]).toContain('HTTP 403');
  });

  it('handles download timeout', async () => {
    const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
    (globalThis.fetch as any).mockRejectedValue(timeoutErr);

    const result = await downloadDocumentAttachments(
      [{ attachment: makeAtt('slow.pdf', 'application/pdf', 100), mime: 'application/pdf' }],
      'msgTimeout',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors[0]).toContain('timed out');
  });

  it('handles redirect rejection', async () => {
    const redirectErr = new TypeError('fetch failed: redirect');
    (globalThis.fetch as any).mockRejectedValue(redirectErr);

    const result = await downloadDocumentAttachments(
      [{ attachment: makeAtt('redir.pdf', 'application/pdf', 100), mime: 'application/pdf' }],
      'msgRedir',
    );

    expect(result.docs).toHaveLength(0);
    expect(result.errors[0]).toContain('redirect');
  });
});
