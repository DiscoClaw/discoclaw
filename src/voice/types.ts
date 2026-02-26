/**
 * Voice subsystem types — provider interfaces and supporting data types.
 *
 * These types form the contract between config (DiscoclawConfig voice fields)
 * and the future voice connection + audio pipeline implementation.
 */

// ---------------------------------------------------------------------------
// VoiceConfig — focused subset of DiscoclawConfig for the voice subsystem
// ---------------------------------------------------------------------------

export type VoiceConfig = {
  enabled: boolean;
  sttProvider: 'deepgram' | 'whisper';
  ttsProvider: 'cartesia' | 'kokoro';
  transcriptChannel?: string;
  deepgramApiKey?: string;
  cartesiaApiKey?: string;
};

// ---------------------------------------------------------------------------
// AudioFrame — a chunk of PCM audio data
// ---------------------------------------------------------------------------

export type AudioFrame = {
  /** Raw PCM audio samples. */
  buffer: Buffer;
  /** Sample rate in Hz (e.g. 16000, 48000). */
  sampleRate: number;
  /** Number of audio channels (1 = mono, 2 = stereo). */
  channels: number;
};

// ---------------------------------------------------------------------------
// TranscriptionResult — output from an STT provider
// ---------------------------------------------------------------------------

export type TranscriptionResult = {
  /** The transcribed text. */
  text: string;
  /** Confidence score in [0, 1], if available. */
  confidence?: number;
  /** Whether this is a final (non-interim) transcription. */
  isFinal: boolean;
};

// ---------------------------------------------------------------------------
// SttProvider — streaming speech-to-text session interface
// ---------------------------------------------------------------------------

export interface SttProvider {
  /** Start a new transcription session. */
  start(): Promise<void>;
  /** Feed a chunk of audio into the session. */
  feedAudio(frame: AudioFrame): void;
  /** Register a callback for transcription results. */
  onTranscription(callback: (result: TranscriptionResult) => void): void;
  /** Stop the session and release resources. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TtsProvider — text-to-speech synthesis interface
// ---------------------------------------------------------------------------

export interface TtsProvider {
  /** Synthesize text into a sequence of audio frames. */
  synthesize(text: string): AsyncIterable<AudioFrame>;
}
