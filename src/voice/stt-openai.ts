import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, SttProvider, TranscriptionResult } from './types.js';

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_SILENCE_THRESHOLD_MS = 1500;
const WHISPER_MODEL = 'whisper-1';

export type OpenaiSttOpts = {
  apiKey: string;
  sampleRate: number;
  log: LoggerLike;
  /** Silence duration (ms) before triggering transcription. Default: 1500. */
  silenceThresholdMs?: number;
  /** Override fetch for testing. */
  fetchFn?: typeof globalThis.fetch;
};

/**
 * OpenAI Whisper STT adapter.
 *
 * Whisper is a batch API — there is no streaming endpoint. This adapter
 * buffers incoming PCM frames and triggers transcription when silence is
 * detected (no new audio for `silenceThresholdMs`). On transcribe, it
 * constructs a minimal WAV header, POSTs to the OpenAI transcriptions
 * endpoint, and fires the `onTranscription` callback with `isFinal: true`.
 */
export class OpenaiSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly sampleRate: number;
  private readonly log: LoggerLike;
  private readonly silenceThresholdMs: number;
  private readonly fetchFn: typeof globalThis.fetch;

  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private callback: ((result: TranscriptionResult) => void) | null = null;
  private audioBuffers: Buffer[] = [];
  private totalBytes = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OpenaiSttOpts) {
    this.apiKey = opts.apiKey;
    this.sampleRate = opts.sampleRate;
    this.log = opts.log;
    this.silenceThresholdMs = opts.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.state = 'running';
    this.audioBuffers = [];
    this.totalBytes = 0;
    this.log.info('OpenAI Whisper STT started');
  }

  feedAudio(frame: AudioFrame): void {
    if (this.state !== 'running') {
      throw new Error('Cannot feedAudio before start() or after stop()');
    }

    this.audioBuffers.push(frame.buffer);
    this.totalBytes += frame.buffer.length;

    // Reset silence timer on every audio frame
    this.resetSilenceTimer();
  }

  onTranscription(callback: (result: TranscriptionResult) => void): void {
    this.callback = callback;
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return;
    this.state = 'stopped';
    this.clearSilenceTimer();

    // Transcribe any remaining buffered audio
    if (this.totalBytes > 0) {
      await this.transcribeBuffer();
    }

    this.audioBuffers = [];
    this.totalBytes = 0;
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.onSilenceDetected();
    }, this.silenceThresholdMs);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private onSilenceDetected(): void {
    if (this.state !== 'running' || this.totalBytes === 0) return;
    this.transcribeBuffer().catch((err) => {
      this.log.error({ err }, 'OpenAI Whisper transcription failed');
    });
  }

  private async transcribeBuffer(): Promise<void> {
    const pcm = Buffer.concat(this.audioBuffers);
    this.audioBuffers = [];
    this.totalBytes = 0;

    const wav = buildWav(pcm, this.sampleRate, 1);

    this.log.info(
      { pcmBytes: pcm.length, wavBytes: wav.length },
      'OpenAI Whisper: sending audio for transcription',
    );

    try {
      const formData = new FormData();
      // Copy into a plain ArrayBuffer so TypeScript accepts it as BlobPart
      const ab = new ArrayBuffer(wav.byteLength);
      new Uint8Array(ab).set(new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength));
      formData.append('file', new Blob([ab], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', WHISPER_MODEL);

      const response = await this.fetchFn(OPENAI_TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const body = await response.text();
        this.log.error(
          { status: response.status, body: body.slice(0, 200) },
          'OpenAI Whisper API error',
        );
        return;
      }

      const data = (await response.json()) as { text?: string };
      const text = data.text?.trim() ?? '';

      if (text.length === 0) {
        this.log.info('OpenAI Whisper: empty transcription, skipping callback');
        return;
      }

      this.log.info({ text: text.slice(0, 80) }, 'OpenAI Whisper transcription');

      if (this.callback) {
        this.callback({ text, isFinal: true });
      }
    } catch (err) {
      this.log.error({ err }, 'OpenAI Whisper transcription request failed');
    }
  }
}

// ---------------------------------------------------------------------------
// WAV header construction (PCM s16le mono)
// ---------------------------------------------------------------------------

/**
 * Build a minimal WAV file from raw PCM s16le data.
 * 16-bit samples, mono, at the given sample rate.
 */
export function buildWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);

  // RIFF chunk descriptor
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  header.write('WAVE', 8);

  // fmt sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
