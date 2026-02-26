import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute, name, schema, sniffMediaType } from './image-download.js';

// Minimal valid PNG: 8-byte signature
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
// Minimal valid JPEG: SOI + marker
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
// Minimal valid GIF: GIF89a
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
// Minimal valid WebP: RIFF....WEBP
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46,  // RIFF
  0x00, 0x00, 0x00, 0x00,  // file size (placeholder)
  0x57, 0x45, 0x42, 0x50,  // WEBP
]);

describe('image-download schema', () => {
  it('has correct name and shape', () => {
    expect(name).toBe('download_image');
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('download_image');
    expect(schema.function.parameters).toHaveProperty('required', ['url']);
  });
});

describe('sniffMediaType', () => {
  it('detects PNG', () => {
    expect(sniffMediaType(PNG_HEADER)).toBe('image/png');
  });

  it('detects JPEG', () => {
    expect(sniffMediaType(JPEG_HEADER)).toBe('image/jpeg');
  });

  it('detects GIF', () => {
    expect(sniffMediaType(GIF_HEADER)).toBe('image/gif');
  });

  it('detects WebP', () => {
    expect(sniffMediaType(WEBP_HEADER)).toBe('image/webp');
  });

  it('returns null for unknown formats', () => {
    expect(sniffMediaType(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });

  it('returns null for empty buffer', () => {
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });
});

describe('image-download execute', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('downloads and returns a PNG image as base64', async () => {
    // Create a minimal valid PNG (header + some padding)
    const pngData = Buffer.concat([PNG_HEADER, Buffer.alloc(100)]);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(pngData, { status: 200 }),
    );

    const r = await execute({ url: 'https://example.com/image.png' }, ['/tmp']);
    expect(r.ok).toBe(true);

    const parsed = JSON.parse(r.result);
    expect(parsed.media_type).toBe('image/png');
    expect(parsed.base64).toBe(pngData.toString('base64'));
    expect(parsed.size).toBe(pngData.length);
  });

  it('returns error when url is missing', async () => {
    const r = await execute({}, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('url');
  });

  it('rejects HTTP (non-HTTPS) URLs', async () => {
    const r = await execute({ url: 'http://example.com/image.png' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('HTTPS');
  });

  it('rejects private IP addresses', async () => {
    const r = await execute({ url: 'https://10.0.0.1/image.png' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('private');
  });

  it('rejects localhost', async () => {
    const r = await execute({ url: 'https://localhost/image.png' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('localhost');
  });

  it('rejects 192.168.x addresses', async () => {
    const r = await execute({ url: 'https://192.168.1.1/image.png' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('private');
  });

  it('rejects loopback IP (127.x)', async () => {
    const r = await execute({ url: 'https://127.0.0.1/image.png' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('private');
  });

  it('rejects invalid URLs', async () => {
    const r = await execute({ url: 'not-a-url' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid URL');
  });

  it('returns error for non-image content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('plain text', { status: 200 }),
    );

    const r = await execute({ url: 'https://example.com/file.txt' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Not a recognized image format');
  });

  it('returns error on HTTP error status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );

    const r = await execute({ url: 'https://example.com/missing.png' }, ['/tmp']);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('404');
  });
});
