import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('sharp', () => {
  const mockSharp = vi.fn();
  return { default: mockSharp };
});

import sharp from 'sharp';
import { maybeDownscale, MAX_IMAGE_DIMENSION } from './resize.js';

// --- Mock helpers ---

interface MockOpts {
  width?: number;
  height?: number;
  resizedBuffer?: Buffer;
  metadataError?: Error;
}

function setupSharpMock(opts: MockOpts = {}) {
  const resizedBuf = opts.resizedBuffer ?? Buffer.from('resized');
  const instance = {
    metadata: opts.metadataError
      ? vi.fn().mockRejectedValue(opts.metadataError)
      : vi.fn().mockResolvedValue({ width: opts.width, height: opts.height }),
    resize: vi.fn(),
    toFormat: vi.fn(),
    toBuffer: vi.fn().mockResolvedValue(resizedBuf),
  };
  instance.resize.mockReturnValue(instance);
  instance.toFormat.mockReturnValue(instance);

  (sharp as unknown as ReturnType<typeof vi.fn>).mockReturnValue(instance);
  return instance;
}

beforeEach(() => {
  vi.mocked(sharp).mockReset();
});

// --- Tests ---

describe('maybeDownscale', () => {
  it('exports MAX_IMAGE_DIMENSION as 1600', () => {
    expect(MAX_IMAGE_DIMENSION).toBe(1600);
  });

  it('returns unchanged when image fits within the limit', async () => {
    const buf = Buffer.from('small-image');
    setupSharpMock({ width: 800, height: 600 });

    const result = await maybeDownscale(buf, 'image/png');

    expect(result.buffer).toBe(buf);
    expect(result.mediaType).toBe('image/png');
    expect(result.resized).toBe(false);
  });

  it('returns unchanged when image is exactly at the limit', async () => {
    const buf = Buffer.from('exact-image');
    setupSharpMock({ width: 1600, height: 1200 });

    const result = await maybeDownscale(buf, 'image/png');

    expect(result.buffer).toBe(buf);
    expect(result.resized).toBe(false);
  });

  it('downscales when width exceeds the limit', async () => {
    const original = Buffer.from('wide-image');
    const resized = Buffer.from('resized-wide');
    const mock = setupSharpMock({ width: 3200, height: 1800, resizedBuffer: resized });

    const result = await maybeDownscale(original, 'image/png');

    expect(result.buffer).toBe(resized);
    expect(result.mediaType).toBe('image/png');
    expect(result.resized).toBe(true);
    expect(mock.resize).toHaveBeenCalledWith({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(mock.toFormat).toHaveBeenCalledWith('png');
  });

  it('downscales when height exceeds the limit (portrait)', async () => {
    const original = Buffer.from('tall-image');
    const resized = Buffer.from('resized-tall');
    const mock = setupSharpMock({ width: 1000, height: 2400, resizedBuffer: resized });

    const result = await maybeDownscale(original, 'image/jpeg');

    expect(result.buffer).toBe(resized);
    expect(result.resized).toBe(true);
    expect(mock.toFormat).toHaveBeenCalledWith('jpeg');
  });

  it('preserves webp format when downscaling', async () => {
    const original = Buffer.from('big-webp');
    const resized = Buffer.from('resized-webp');
    const mock = setupSharpMock({ width: 4000, height: 3000, resizedBuffer: resized });

    const result = await maybeDownscale(original, 'image/webp');

    expect(result.buffer).toBe(resized);
    expect(result.resized).toBe(true);
    expect(mock.toFormat).toHaveBeenCalledWith('webp');
  });

  it('skips GIF even when oversized', async () => {
    const buf = Buffer.from('big-gif');

    const result = await maybeDownscale(buf, 'image/gif');

    expect(result.buffer).toBe(buf);
    expect(result.mediaType).toBe('image/gif');
    expect(result.resized).toBe(false);
    expect(sharp).not.toHaveBeenCalled();
  });

  it('returns unchanged on sharp metadata error', async () => {
    const buf = Buffer.from('corrupt-image');
    setupSharpMock({ metadataError: new Error('Input buffer contains unsupported image format') });

    const result = await maybeDownscale(buf, 'image/png');

    expect(result.buffer).toBe(buf);
    expect(result.mediaType).toBe('image/png');
    expect(result.resized).toBe(false);
  });

  it('returns unchanged when metadata has no dimensions', async () => {
    const buf = Buffer.from('no-dims');
    setupSharpMock({ width: undefined, height: undefined });

    const result = await maybeDownscale(buf, 'image/png');

    expect(result.buffer).toBe(buf);
    expect(result.resized).toBe(false);
  });

  it('returns unchanged for unsupported media type even when oversized', async () => {
    const buf = Buffer.from('unknown-format');
    setupSharpMock({ width: 3000, height: 2000 });

    const result = await maybeDownscale(buf, 'image/tiff');

    expect(result.buffer).toBe(buf);
    expect(result.mediaType).toBe('image/tiff');
    expect(result.resized).toBe(false);
  });

  it('returns unchanged when toBuffer throws (resize failure)', async () => {
    const buf = Buffer.from('resize-fail');
    const instance = setupSharpMock({ width: 3000, height: 2000 });
    instance.toBuffer.mockRejectedValue(new Error('resize failed'));

    const result = await maybeDownscale(buf, 'image/png');

    expect(result.buffer).toBe(buf);
    expect(result.resized).toBe(false);
  });

  it('downscales at width = MAX_IMAGE_DIMENSION + 1', async () => {
    const original = Buffer.from('just-over');
    const resized = Buffer.from('resized');
    setupSharpMock({ width: 1601, height: 900, resizedBuffer: resized });

    const result = await maybeDownscale(original, 'image/jpeg');

    expect(result.resized).toBe(true);
    expect(result.buffer).toBe(resized);
  });
});
