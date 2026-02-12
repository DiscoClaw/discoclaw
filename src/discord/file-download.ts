import type { AttachmentLike } from './image-download.js';

// Keep in sync with image-download.ts
const ALLOWED_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** Max bytes per individual text file (100 KB). Files exceeding this are truncated. */
const MAX_FILE_BYTES = 100 * 1024;

/** Max total bytes across all text files in one message (200 KB). */
const MAX_TOTAL_BYTES = 200 * 1024;

/** Per-file download timeout (10 seconds). */
const DOWNLOAD_TIMEOUT_MS = 10_000;

/** MIME types that are treated as text (checked via startsWith for text/*). */
const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
]);

/** Extension-to-MIME fallback map for text types. */
const EXT_TO_TEXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  md: 'text/markdown',
  js: 'application/javascript',
  ts: 'application/typescript',
  xml: 'application/xml',
  html: 'text/html',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  py: 'text/x-script',
  rb: 'text/x-script',
  sh: 'text/x-script',
  bash: 'text/x-script',
  zsh: 'text/x-script',
};

export type TextDownloadResult = {
  texts: Array<{ name: string; content: string }>;
  errors: string[];
};

/**
 * Resolve a text MIME type from contentType or file extension.
 * Returns the MIME string if it's a supported text type, null otherwise.
 */
export function resolveTextType(attachment: AttachmentLike): string | null {
  if (attachment.contentType) {
    const mime = attachment.contentType.split(';')[0].trim().toLowerCase();
    if (mime.startsWith('text/')) return mime;
    if (TEXT_APPLICATION_TYPES.has(mime)) return mime;
  }

  const name = attachment.name ?? '';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = name.slice(dotIdx + 1).toLowerCase();
    const mime = EXT_TO_TEXT_MIME[ext];
    if (mime) return mime;
  }

  return null;
}

/** Check if a MIME type is a supported text type. */
export function isTextType(mime: string): boolean {
  return mime.startsWith('text/') || TEXT_APPLICATION_TYPES.has(mime);
}

/** Sanitize an attachment filename for display. */
function safeName(attachment: AttachmentLike): string {
  const raw = attachment.name ?? 'unknown';
  return raw.replace(/[\x00-\x1f]/g, '').slice(0, 100).trim() || 'unknown';
}

/**
 * Classify attachments into text, unsupported, and image (skipped) buckets.
 * Image attachments are excluded — they're handled by image-download.ts.
 */
export function classifyAttachments(attachments: Iterable<AttachmentLike>): {
  text: Array<{ attachment: AttachmentLike; mime: string }>;
  unsupported: AttachmentLike[];
} {
  const text: Array<{ attachment: AttachmentLike; mime: string }> = [];
  const unsupported: AttachmentLike[] = [];

  for (const att of attachments) {
    const textMime = resolveTextType(att);
    if (textMime) {
      text.push({ attachment: att, mime: textMime });
    } else {
      unsupported.push(att);
    }
  }

  return { text, unsupported };
}

/**
 * Download non-image text attachments from a Discord message.
 *
 * - Filters for text-like MIME types
 * - Truncates files exceeding MAX_FILE_BYTES with a marker
 * - Skips files once MAX_TOTAL_BYTES is reached
 * - Notes unsupported attachment types in errors
 */
export async function downloadTextAttachments(
  attachments: Iterable<AttachmentLike>,
): Promise<TextDownloadResult> {
  const { text: candidates, unsupported } = classifyAttachments(attachments);

  const errors: string[] = [];

  // Note unsupported types
  for (const att of unsupported) {
    const name = safeName(att);
    const mime = att.contentType?.split(';')[0].trim() ?? 'unknown';
    errors.push(`[Unsupported attachment: ${name} (${mime})]`);
  }

  if (candidates.length === 0) return { texts: [], errors };

  const texts: Array<{ name: string; content: string }> = [];
  let totalBytes = 0;

  for (const { attachment, mime } of candidates) {
    const name = safeName(attachment);

    // Total budget check
    if (totalBytes >= MAX_TOTAL_BYTES) {
      errors.push(`${name}: skipped (total size limit exceeded)`);
      continue;
    }

    // SSRF protection
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(attachment.url);
    } catch {
      errors.push(`${name}: invalid URL`);
      continue;
    }

    if (parsedUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsedUrl.hostname)) {
      errors.push(`${name}: blocked (non-Discord CDN host)`);
      continue;
    }

    // Pre-check size from Discord metadata for total budget
    const metaSize = attachment.size ?? 0;
    if (metaSize > 0 && totalBytes + metaSize > MAX_TOTAL_BYTES) {
      errors.push(`${name}: skipped (total size limit exceeded)`);
      continue;
    }

    try {
      const response = await fetch(attachment.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      });

      if (!response.ok) {
        errors.push(`${name}: HTTP ${response.status}`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      totalBytes += buffer.length;

      // Decode as UTF-8
      let content: string;
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        content = decoder.decode(buffer);
      } catch {
        errors.push(`${name}: not valid UTF-8 text`);
        continue;
      }

      // Truncate if exceeding per-file limit
      if (buffer.length > MAX_FILE_BYTES) {
        const truncated = content.slice(0, MAX_FILE_BYTES);
        texts.push({ name, content: truncated + '\n[truncated at 100KB]' });
      } else {
        texts.push({ name, content });
      }
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : null;
      if (errObj?.name === 'TimeoutError' || errObj?.name === 'AbortError') {
        errors.push(`${name}: download timed out`);
      } else if (errObj?.name === 'TypeError' && String(errObj.message).includes('redirect')) {
        errors.push(`${name}: blocked (unexpected redirect)`);
      } else {
        errors.push(`${name}: download failed`);
      }
    }
  }

  return { texts, errors };
}
