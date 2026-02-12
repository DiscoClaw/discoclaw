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
export function safeName(attachment: AttachmentLike): string {
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

    return {
      ok: true,
      image: {
        base64: buffer.toString('base64'),
        mediaType,
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

// ---------------------------------------------------------------------------
// Text file attachment support
// ---------------------------------------------------------------------------

/** Max bytes per individual text file (100 KB). */
const MAX_TEXT_FILE_BYTES = 100 * 1024;

/** Max total text bytes across all files in one message (500 KB). */
const MAX_TOTAL_TEXT_BYTES = 500 * 1024;

/** Max number of text files to inline per message. */
const MAX_TEXT_FILES = 5;

/** Recognized text file extensions for inlining. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'xml', 'html', 'css',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'h',
  'sh', 'sql', 'log', 'cfg', 'ini', 'conf', 'env',
]);

/** MIME type prefixes that indicate text content. */
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/yaml', 'application/toml'];

export type TextFileData = {
  name: string;
  content: string;
};

export type TextDownloadResult = {
  /** Successfully downloaded text files. */
  files: TextFileData[];
  /** URLs for binary (non-image, non-text) attachments. */
  urls: string[];
  /** Error messages for files that could not be downloaded. */
  errors: string[];
};

/**
 * Check if an attachment is a text file suitable for inlining.
 * Returns true if the MIME type or file extension indicates text content,
 * AND the attachment is not an image (images are handled separately).
 */
export function isTextAttachment(attachment: AttachmentLike): boolean {
  // Exclude images — they have their own pipeline.
  if (resolveMediaType(attachment)) return false;

  // Check MIME type.
  if (attachment.contentType) {
    const mime = attachment.contentType.split(';')[0].trim().toLowerCase();
    if (TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
  }

  // Check file extension.
  const name = attachment.name ?? '';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = name.slice(dotIdx + 1).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

/**
 * Download a single text file attachment.
 * Uses the same SSRF protections as downloadAttachment.
 */
export async function downloadTextAttachment(
  attachment: AttachmentLike,
): Promise<{ ok: true; file: TextFileData } | { ok: false; error: string }> {
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
  if (attachment.size != null && attachment.size > MAX_TEXT_FILE_BYTES) {
    const sizeKB = (attachment.size / 1024).toFixed(1);
    return { ok: false, error: `${name}: too large (${sizeKB} KB, max 100 KB)` };
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
    if (buffer.length > MAX_TEXT_FILE_BYTES) {
      const sizeKB = (buffer.length / 1024).toFixed(1);
      return { ok: false, error: `${name}: too large (${sizeKB} KB, max 100 KB)` };
    }

    return {
      ok: true,
      file: { name, content: buffer.toString('utf-8') },
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
 * Download text file attachments from a Discord message.
 *
 * Filters out images (handled separately), inlines text files,
 * and collects URLs for binary non-image attachments.
 */
export async function downloadMessageTextFiles(
  attachments: Iterable<AttachmentLike>,
): Promise<TextDownloadResult> {
  const textCandidates: AttachmentLike[] = [];
  const binaryUrls: string[] = [];

  for (const att of attachments) {
    // Skip images — they're handled by downloadMessageImages.
    if (resolveMediaType(att)) continue;

    if (isTextAttachment(att)) {
      textCandidates.push(att);
    } else {
      binaryUrls.push(att.url);
    }
  }

  // Cap at MAX_TEXT_FILES.
  const toDownload = textCandidates.slice(0, MAX_TEXT_FILES);
  const errors: string[] = [];

  if (textCandidates.length > MAX_TEXT_FILES) {
    for (const skipped of textCandidates.slice(MAX_TEXT_FILES)) {
      errors.push(`${safeName(skipped)}: skipped (max ${MAX_TEXT_FILES} text files per message)`);
      binaryUrls.push(skipped.url);
    }
  }

  // Pre-check total byte budget from Discord metadata.
  let estimatedTotal = 0;
  const withinBudget: AttachmentLike[] = [];

  for (const att of toDownload) {
    const size = att.size ?? 0;
    if (estimatedTotal + size > MAX_TOTAL_TEXT_BYTES) {
      errors.push(`${safeName(att)}: skipped (total text size limit exceeded)`);
      binaryUrls.push(att.url);
      continue;
    }
    estimatedTotal += size;
    withinBudget.push(att);
  }

  if (withinBudget.length === 0) return { files: [], urls: binaryUrls, errors };

  // Download all in parallel.
  const results = await Promise.all(
    withinBudget.map((att) => downloadTextAttachment(att)),
  );

  const files: TextFileData[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.ok) {
      files.push(result.file);
    } else {
      errors.push(result.error);
      binaryUrls.push(withinBudget[i].url);
    }
  }

  return { files, urls: binaryUrls, errors };
}
