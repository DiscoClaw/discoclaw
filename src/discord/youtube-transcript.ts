import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptInvalidVideoIdError,
} from 'youtube-transcript-plus';

/** Max characters of transcript text to include per video. */
export const MAX_TRANSCRIPT_CHARS = 8_000;

/** Max number of YouTube videos to process per message. */
export const MAX_VIDEOS_PER_MESSAGE = 3;

/** Per-request timeout for YouTube fetches (15 seconds). */
const FETCH_TIMEOUT_MS = 15_000;

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
  // Embed URL (/embed/)
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
  // Shorts URL (/shorts/)
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
  // Legacy Flash embed URL (/v/)
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
  // Legacy redirect URL (/e/)
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/e\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/g,
];

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
 * Fetch the plain-text transcript for a YouTube video ID using the InnerTube API.
 *
 * Wraps the youtube-transcript-plus library with a 15-second timeout.
 * Throws a descriptive Error on any failure.
 */
export async function fetchTranscriptForVideo(videoId: string): Promise<string> {
  let segments: Awaited<ReturnType<typeof fetchTranscript>>;

  try {
    segments = await Promise.race([
      fetchTranscript(videoId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), FETCH_TIMEOUT_MS)
      ),
    ]);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : null;
    if (e?.message === 'timed out' || e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('timed out');
    }
    if (
      err instanceof YoutubeTranscriptDisabledError ||
      err instanceof YoutubeTranscriptNotAvailableError ||
      err instanceof YoutubeTranscriptVideoUnavailableError ||
      err instanceof YoutubeTranscriptNotAvailableLanguageError ||
      err instanceof YoutubeTranscriptTooManyRequestError ||
      err instanceof YoutubeTranscriptInvalidVideoIdError
    ) {
      throw new Error('no captions available');
    }
    throw err;
  }

  if (segments.length === 0) {
    throw new Error('transcript is empty');
  }

  const text = segments.map(s => s.text).join(' ').trim();
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
