/** Max characters of transcript text to include per video. */
export const MAX_TRANSCRIPT_CHARS = 8_000;

/** Max number of YouTube videos to process per message. */
export const MAX_VIDEOS_PER_MESSAGE = 3;

/** Per-request timeout for YouTube fetches (15 seconds). */
const FETCH_TIMEOUT_MS = 15_000;

/** Allowed hosts for caption track URLs (SSRF protection). */
const ALLOWED_CAPTION_HOSTS = new Set(['www.youtube.com', 'youtube.com']);

/**
 * Prompt injection detection patterns applied to transcript text.
 * Transcripts containing these patterns are blocked.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /new\s+system\s+prompt/i,
  /disregard\s+(your\s+)?(previous\s+)?instructions?/i,
  /override\s+(your\s+)?(previous\s+)?instructions?/i,
  /forget\s+(your\s+)?(previous\s+)?instructions?/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /act\s+as\s+(a|an)\s+/i,
  /<\s*\/?\s*(system|instruction|prompt)\s*>/i,
  /\[INST\]/i,
  /###\s*(human|assistant|system)/i,
  /jailbreak/i,
];

/** YouTube URL regex patterns — each has one capture group for the video ID. */
const YT_URL_REGEXES: RegExp[] = [
  // Standard watch URL — v= may appear after other query params
  /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?(?:[^&\s]*&)*v=([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
  // Short URL
  /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
  // Embed URL
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
  // Shorts URL
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
];

export type CaptionTrack = {
  baseUrl: string;
  languageCode?: string;
  name?: { simpleText?: string };
};

export type TranscriptResult = {
  transcripts: Array<{ videoId: string; text: string }>;
  errors: string[];
};

/**
 * Extract unique YouTube video IDs from a text string.
 * Returns at most MAX_VIDEOS_PER_MESSAGE IDs in order of first appearance.
 */
export function extractYouTubeIds(text: string): string[] {
  const ids = new Set<string>();
  for (const pattern of YT_URL_REGEXES) {
    // Re-instantiate the regex to reset lastIndex
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      ids.add(match[1]);
    }
  }
  return [...ids].slice(0, MAX_VIDEOS_PER_MESSAGE);
}

/**
 * Check whether transcript text contains prompt injection patterns.
 * Returns true if a potential injection attempt is detected.
 */
export function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(p => p.test(text));
}

/**
 * Truncate transcript text to MAX_TRANSCRIPT_CHARS, appending a marker when truncated.
 */
export function truncateTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return text.slice(0, MAX_TRANSCRIPT_CHARS) + `\n[transcript truncated at ${MAX_TRANSCRIPT_CHARS} chars]`;
}

/**
 * Extract the captionTracks array from a YouTube video page's HTML.
 * Returns the parsed array, or null if not found or not parseable.
 */
export function extractCaptionTracksFromHtml(html: string): CaptionTrack[] | null {
  // Match "captionTracks":[...] — YouTube embeds this JSON directly in the page.
  // The lazy .*? stops at the first ] which is reliable because captionTracks items
  // only contain strings and objects (no nested arrays).
  const match = html.match(/"captionTracks":(\[.*?\])/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as CaptionTrack[];
  } catch {
    return null;
  }
}

/**
 * Parse YouTube timedtext XML into plain text.
 * Decodes HTML entities and joins <text> elements with spaces.
 */
export function parseTranscriptXml(xml: string): string {
  const parts: string[] = [];
  const textRegex = /<text[^>]*>([^<]*)<\/text>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    const decoded = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .trim();
    if (decoded) parts.push(decoded);
  }
  return parts.join(' ');
}

/**
 * Fetch the plain-text transcript for a YouTube video ID.
 *
 * Fetches the video page to discover the caption track URL, then fetches and
 * parses the timedtext XML. Throws a descriptive Error on any failure.
 */
export async function fetchTranscriptForVideo(videoId: string): Promise<string> {
  // --- Step 1: fetch the video page ---
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let html: string;
  try {
    const pageResponse = await fetch(pageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pageResponse.ok) {
      throw new Error(`HTTP ${pageResponse.status}`);
    }
    html = await pageResponse.text();
  } catch (err: unknown) {
    const e = err instanceof Error ? err : null;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('timed out');
    throw err;
  }

  // --- Step 2: extract caption tracks from the page HTML ---
  const tracks = extractCaptionTracksFromHtml(html);
  if (!tracks || tracks.length === 0) {
    throw new Error('no captions available');
  }

  // Prefer English, fall back to first available track
  const track =
    tracks.find(t => t.languageCode === 'en') ??
    tracks.find(t => t.languageCode?.startsWith('en')) ??
    tracks[0];

  if (typeof track.baseUrl !== 'string' || !track.baseUrl) {
    throw new Error('no captions available');
  }

  // SSRF protection: only fetch from youtube.com
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(track.baseUrl);
  } catch {
    throw new Error('no captions available');
  }
  if (parsedUrl.protocol !== 'https:' || !ALLOWED_CAPTION_HOSTS.has(parsedUrl.hostname)) {
    throw new Error('caption URL blocked (not from youtube.com)');
  }

  // --- Step 3: fetch and parse the timedtext XML ---
  let xml: string;
  try {
    const captionsResponse = await fetch(track.baseUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!captionsResponse.ok) {
      throw new Error(`captions fetch failed (HTTP ${captionsResponse.status})`);
    }
    xml = await captionsResponse.text();
  } catch (err: unknown) {
    const e = err instanceof Error ? err : null;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error('timed out');
    throw err;
  }

  const text = parseTranscriptXml(xml);
  if (!text) {
    throw new Error('transcript is empty');
  }

  return text;
}

/**
 * Fetch YouTube transcripts for all YouTube URLs found in a Discord message.
 *
 * - Extracts up to MAX_VIDEOS_PER_MESSAGE video IDs
 * - Scans each transcript for prompt injection — blocked transcripts produce an error entry
 * - Truncates transcripts exceeding MAX_TRANSCRIPT_CHARS
 *
 * Returns transcript blocks and any error/warning strings suitable for appending to a prompt.
 */
export async function fetchYouTubeTranscripts(messageText: string): Promise<TranscriptResult> {
  const videoIds = extractYouTubeIds(messageText);
  if (videoIds.length === 0) return { transcripts: [], errors: [] };

  const transcripts: Array<{ videoId: string; text: string }> = [];
  const errors: string[] = [];

  for (const videoId of videoIds) {
    try {
      const raw = await fetchTranscriptForVideo(videoId);

      if (containsInjection(raw)) {
        errors.push(`youtube:${videoId}: blocked (potential prompt injection in transcript)`);
        continue;
      }

      transcripts.push({ videoId, text: truncateTranscript(raw) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      errors.push(`youtube:${videoId}: ${msg}`);
    }
  }

  return { transcripts, errors };
}
