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
 * Oversized GIFs are converted to PNG (sharp strips animation frames, but a
 * static thumbnail is better than bricking the channel with API errors).
 * On any sharp error the original buffer is returned so callers degrade
 * gracefully rather than failing.
 */
export async function maybeDownscale(
  buffer: Buffer,
  mediaType: string,
): Promise<DownscaleResult> {
  try {
    const isGif = mediaType === 'image/gif';
    const image = sharp(buffer, isGif ? { animated: false } : undefined);
    const { width, height } = await image.metadata();

    if (!width || !height) {
      return { buffer, mediaType, resized: false };
    }

    if (Math.max(width, height) <= MAX_IMAGE_DIMENSION) {
      return { buffer, mediaType, resized: false };
    }

    // GIFs get converted to PNG; other formats keep their own format.
    const outFormat: keyof sharp.FormatEnum = isGif ? 'png' : (MEDIA_TO_SHARP[mediaType] as keyof sharp.FormatEnum);
    if (!outFormat) {
      return { buffer, mediaType, resized: false };
    }

    const resizedBuffer = await image
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toFormat(outFormat)
      .toBuffer();

    const outMediaType = isGif ? 'image/png' : mediaType;
    return { buffer: resizedBuffer, mediaType: outMediaType, resized: true };
  } catch {
    return { buffer, mediaType, resized: false };
  }
}
