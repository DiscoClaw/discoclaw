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
  return attachment.name ?? 'unknown';
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

    return {
      ok: true,
      image: {
        base64: buffer.toString('base64'),
        mediaType,
      },
    };
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, error: `${name}: download timed out` };
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
    if (estimatedTotal + size > MAX_TOTAL_BYTES && withinBudget.length > 0) {
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
