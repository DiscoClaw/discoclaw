import sharp from 'sharp';

/** Anthropic API dimension limit — images wider or taller get downscaled. */
export const MAX_IMAGE_DIMENSION = 1600;

export interface DownscaleResult {
  buffer: Buffer;
  mediaType: string;
  resized: boolean;
}

const MEDIA_TO_SHARP: Record<string, keyof sharp.FormatEnum> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

/**
 * Downscale an image if its longest side exceeds {@link MAX_IMAGE_DIMENSION}.
 * GIFs are returned unchanged (sharp would strip animation frames).
 * On any sharp error the original buffer is returned so callers degrade
 * gracefully rather than failing.
 */
export async function maybeDownscale(
  buffer: Buffer,
  mediaType: string,
): Promise<DownscaleResult> {
  if (mediaType === 'image/gif') {
    return { buffer, mediaType, resized: false };
  }

  try {
    const image = sharp(buffer);
    const { width, height } = await image.metadata();

    if (!width || !height) {
      return { buffer, mediaType, resized: false };
    }

    if (Math.max(width, height) <= MAX_IMAGE_DIMENSION) {
      return { buffer, mediaType, resized: false };
    }

    const format = MEDIA_TO_SHARP[mediaType];
    if (!format) {
      return { buffer, mediaType, resized: false };
    }

    const resizedBuffer = await image
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFormat(format)
      .toBuffer();

    return { buffer: resizedBuffer, mediaType, resized: true };
  } catch {
    return { buffer, mediaType, resized: false };
  }
}
