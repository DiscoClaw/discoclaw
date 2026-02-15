import type { ImageData } from '../runtime/types.js';
import { MAX_IMAGES_PER_INVOCATION } from '../runtime/types.js';

/** Allowed Discord CDN hosts (SSRF protection). */
const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** Max bytes per individual image (20 MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Max total bytes across all images in one message (50 MB). */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** Per-image download timeout (10 seconds). */
const DOWNLOAD_TIMEOUT_MS = 10_000;

/** Supported image MIME types. */
const SUPPORTED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** Extension-to-MIME fallback map. */
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

// Per-format minimum payload sizes (structural floors for each format).
export const MIN_PNG_BYTES = 45;   // sig(8) + IHDR(25) + IEND(12)
export const MIN_JPEG_BYTES = 20;  // SOI(2) + marker(4) + frame(11) + EOI(2) ≈ 19, rounded up
export const MIN_GIF_BYTES = 26;   // header(6) + LSD(7) + image desc(10) + LZW(2) + trailer(1)
export const MIN_WEBP_BYTES = 26;  // RIFF(12) + VP8 chunk header(8) + minimal frame(6)

const MIN_BYTES_FOR_TYPE: Record<string, number> = {
  'image/png': MIN_PNG_BYTES,
  'image/jpeg': MIN_JPEG_BYTES,
  'image/gif': MIN_GIF_BYTES,
  'image/webp': MIN_WEBP_BYTES,
};

/**
 * Sniff the image format from magic bytes.
 * Returns the MIME type string or null if unrecognized.
 */
export function sniffMediaType(buffer: Buffer): string | null {
  // PNG: 8-byte signature 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return 'image/png';
  }

  // JPEG: 3-byte SOI + marker FF D8 FF
  if (buffer.length >= 3 &&
      buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // GIF: 6-byte version string GIF87a or GIF89a
  if (buffer.length >= 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  return null;
}

export type DownloadResult = {
  images: ImageData[];
  errors: string[];
};

/** Discord attachment shape (subset of discord.js Attachment). */
export type AttachmentLike = {
  url: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
};

/**
 * Resolve a Discord attachment's MIME type from its contentType or filename extension.
 * Returns null if the attachment is not a supported image format.
 */
export function resolveMediaType(attachment: AttachmentLike): string | null {
  // Prefer Discord's reported contentType.
  if (attachment.contentType) {
    const mime = attachment.contentType.split(';')[0].trim().toLowerCase();
    if (SUPPORTED_MEDIA_TYPES.has(mime)) return mime;
  }

  // Fall back to file extension.
  const name = attachment.name ?? '';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = name.slice(dotIdx + 1).toLowerCase();
    const mime = EXT_TO_MIME[ext];
    if (mime) return mime;
  }

  return null;
}

/** Sanitize an attachment filename for error messages (no URLs or query params). */
function safeName(attachment: AttachmentLike): string {
  const raw = attachment.name ?? 'unknown';
  return raw.replace(/[\x00-\x1f]/g, '').slice(0, 100).trim() || 'unknown';
}

/**
 * Download a single Discord image attachment.
 * Returns the ImageData on success, or an error string on failure.
 */
export async function downloadAttachment(
  attachment: AttachmentLike,
  mediaType: string,
): Promise<{ ok: true; image: ImageData } | { ok: false; error: string }> {
  const name = safeName(attachment);

  // SSRF protection: validate host.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(attachment.url);
  } catch {
    return { ok: false, error: `${name}: invalid URL` };
  }

  if (parsedUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsedUrl.hostname)) {
    return { ok: false, error: `${name}: blocked (non-Discord CDN host)` };
  }

  // Pre-check size from Discord metadata.
  if (attachment.size != null && attachment.size > MAX_IMAGE_BYTES) {
    const sizeMB = (attachment.size / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `${name}: too large (${sizeMB} MB, max 20 MB)` };
  }

  try {
    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'error',
    });

    if (!response.ok) {
      return { ok: false, error: `${name}: HTTP ${response.status}` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Post-download size check.
    if (buffer.length > MAX_IMAGE_BYTES) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      return { ok: false, error: `${name}: too large (${sizeMB} MB, max 20 MB)` };
    }

    // Sniff actual format from magic bytes — override declared MIME.
    const sniffed = sniffMediaType(buffer);
    if (!sniffed) {
      return { ok: false, error: `${name}: unsupported image format (magic bytes don't match PNG, JPEG, GIF, or WebP)` };
    }

    // Reject truncated payloads below format structural minimums.
    const minBytes = MIN_BYTES_FOR_TYPE[sniffed];
    if (minBytes && buffer.length < minBytes) {
      return { ok: false, error: `${name}: image too small to be valid ${sniffed} (${buffer.length} bytes, minimum ${minBytes})` };
    }

    return {
      ok: true,
      image: {
        base64: buffer.toString('base64'),
        mediaType: sniffed,
      },
    };
  } catch (err: unknown) {
    const errObj = err instanceof Error ? err : null;
    if (errObj?.name === 'TimeoutError' || errObj?.name === 'AbortError') {
      return { ok: false, error: `${name}: download timed out` };
    }
    if (errObj?.name === 'TypeError' && String(errObj.message).includes('redirect')) {
      return { ok: false, error: `${name}: blocked (unexpected redirect)` };
    }
    return { ok: false, error: `${name}: download failed` };
  }
}

/**
 * Download image attachments from a Discord message.
 *
 * Filters for supported image types, respects MAX_IMAGES_PER_INVOCATION,
 * and enforces a total byte cap across all images.
 */
export async function downloadMessageImages(
  attachments: Iterable<AttachmentLike>,
  maxImages: number = MAX_IMAGES_PER_INVOCATION,
): Promise<DownloadResult> {
  // Filter to supported image attachments with resolved MIME types.
  const candidates: Array<{ attachment: AttachmentLike; mediaType: string }> = [];
  for (const att of attachments) {
    const mediaType = resolveMediaType(att);
    if (mediaType) candidates.push({ attachment: att, mediaType });
  }

  // Cap at maxImages.
  const toDownload = candidates.slice(0, maxImages);
  if (toDownload.length === 0) return { images: [], errors: [] };

  // Pre-check total byte budget from Discord metadata.
  let estimatedTotal = 0;
  const withinBudget: typeof toDownload = [];
  const errors: string[] = [];

  for (const item of toDownload) {
    const size = item.attachment.size ?? 0;
    if (estimatedTotal + size > MAX_TOTAL_BYTES) {
      errors.push(`${safeName(item.attachment)}: skipped (total size limit exceeded)`);
      continue;
    }
    estimatedTotal += size;
    withinBudget.push(item);
  }

  // Download all in parallel.
  const results = await Promise.all(
    withinBudget.map(({ attachment, mediaType }) => downloadAttachment(attachment, mediaType)),
  );

  const images: ImageData[] = [];
  for (const result of results) {
    if (result.ok) {
      images.push(result.image);
    } else {
      errors.push(result.error);
    }
  }

  return { images, errors };
}
