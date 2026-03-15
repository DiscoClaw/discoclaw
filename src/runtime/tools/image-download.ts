/**
 * OpenAI function-calling tool: download_image
 *
 * Downloads an image from a URL and returns it as base64-encoded data.
 * Includes SSRF protections, size limits, and magic-byte validation.
 */

import type { OpenAIFunctionTool, ToolResult } from './types.js';

export const name = 'download_image';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

/** RFC 1918 / private / loopback prefixes for SSRF protection. */
const PRIVATE_IP_PREFIXES = [
  '10.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
  '127.',
  '0.',
  '169.254.',
];

const LOCALHOST_HOSTNAMES = new Set(['localhost', '[::1]']);

const SUPPORTED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const schema: OpenAIFunctionTool = {
  type: 'function',
  function: {
    name: 'download_image',
    description: 'Download an image from a URL and return it as base64-encoded data with its media type.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The HTTPS URL of the image to download.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
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

export async function execute(
  args: Record<string, unknown>,
  _allowedRoots: string[],
): Promise<ToolResult> {
  const url = args.url as string;
  if (!url) return { result: 'url is required', ok: false };

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { result: 'Invalid URL', ok: false };
  }

  // HTTPS only
  if (parsed.protocol !== 'https:') {
    return { result: `Blocked: only HTTPS URLs are allowed (got ${parsed.protocol})`, ok: false };
  }

  // Block private/loopback IPs and localhost
  const hostname = parsed.hostname;
  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return { result: 'Blocked: localhost URLs are not allowed', ok: false };
  }
  if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    return { result: 'Blocked: private/internal IP addresses are not allowed', ok: false };
  }
  if (hostname === '::1' || hostname === '[::1]') {
    return { result: 'Blocked: loopback addresses are not allowed', ok: false };
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });

    if (!response.ok) {
      return { result: `HTTP ${response.status} ${response.statusText}`, ok: false };
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_IMAGE_BYTES) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
      return { result: `Image too large: ${sizeMB} MB (max 20 MB)`, ok: false };
    }

    // Validate image format via magic bytes
    const mediaType = sniffMediaType(buffer);
    if (!mediaType) {
      return { result: 'Not a recognized image format (expected PNG, JPEG, GIF, or WebP)', ok: false };
    }

    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
      return { result: `Unsupported image format: ${mediaType}`, ok: false };
    }

    const base64 = buffer.toString('base64');
    return {
      result: JSON.stringify({ base64, media_type: mediaType, size: buffer.length }),
      ok: true,
    };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : null;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { result: 'Request timed out (15s limit)', ok: false };
    }
    if (e?.name === 'TypeError' && String(e.message).includes('redirect')) {
      return { result: 'Blocked: unexpected redirect', ok: false };
    }
    return { result: e?.message || 'download failed', ok: false };
  }
}
