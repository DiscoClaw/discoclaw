import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { LoggerLike } from '../logging/logger-like.js';
import type { AudioFrame, SttProvider, TranscriptionResult, VoiceConfig } from './types.js';
import type { OpusDecoder } from './audio-receiver.js';
import { AudioPipelineManager, type AudioPipelineOpts } from './audio-pipeline.js';

// ---------------------------------------------------------------------------
// Mock @discordjs/voice
// ---------------------------------------------------------------------------

vi.mock('@discordjs/voice', () => ({
  VoiceConnectionStatus: {
    Signalling: 'signalling',
    Connecting: 'connecting',
    Ready: 'ready',
    Disconnected: 'disconnected',
    Destroyed: 'destroyed',
  },
  EndBehaviorType: { Manual: 0, AfterSilence: 1, AfterInactivity: 2 },
}));

// We don't want real stt-factory or audio-receiver internals — the pipeline
// injects a createStt override and AudioReceiver is tested separately.
// However we do import AudioReceiver for real so the wiring is exercised.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockStt() {
  const stt = {
    transcriptionCb: null as ((result: TranscriptionResult) => void) | null,
    start: vi.fn(async () => {}),
    feedAudio: vi.fn((_frame: AudioFrame) => {}),
    onTranscription: vi.fn((cb: (result: TranscriptionResult) => void) => {
      stt.transcriptionCb = cb;
    }),
    stop: vi.fn(async () => {}),
  };
  return stt;
}

function createMockDecoder(): OpusDecoder {
  return {
    decode: vi.fn((_packet: Buffer) => Buffer.alloc(960 * 2 * 2)),
    destroy: vi.fn(),
  };
}

type StatusLike = { status: string };
type StateChangeListener = (oldState: StatusLike, newState: StatusLike) => void;

function createMockConnection() {
  const stateListeners: StateChangeListener[] = [];
  const speakingEmitter = new EventEmitter();
  const subscriptions = new Map<string, unknown>();
  const streams = new Map<string, EventEmitter>();

  const conn = {
    state: { status: 'signalling' } as StatusLike,
    receiver: {
      speaking: speakingEmitter,
      subscriptions,
      subscribe: vi.fn((userId: string) => {
        const stream = new EventEmitter();
        streams.set(userId, stream);
        subscriptions.set(userId, stream);
        return stream;
      }),
    },
    on: vi.fn((event: string, listener: StateChangeListener) => {
      if (event === 'stateChange') stateListeners.push(listener);
      return conn;
    }),
    _transition(status: string) {
      const old = { ...conn.state };
      conn.state = { status };
      for (const l of stateListeners) l(old, conn.state);
    },
  };

  return {
    connection: conn as unknown as import('@discordjs/voice').VoiceConnection,
    _transition: conn._transition.bind(conn),
    speakingEmitter,
    subscriptions,
    streams,
  };
}

function baseVoiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    sttProvider: 'deepgram',
    ttsProvider: 'cartesia',
    deepgramApiKey: 'test-key',
    ...overrides,
  };
}

function createPipelineOpts(overrides: Partial<AudioPipelineOpts> = {}): AudioPipelineOpts & {
  mockStt: ReturnType<typeof createMockStt>;
} {
  const mockStt = createMockStt();
  return {
    mockStt,
    log: createLogger(),
    voiceConfig: baseVoiceConfig(),
    allowedUserIds: new Set(['111', '222']),
    createDecoder: () => createMockDecoder(),
    createStt: () => mockStt,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AudioPipelineManager', () => {
  describe('startPipeline / stopPipeline', () => {
    it('starts STT and receiver for a guild', async () => {
      const opts = createPipelineOpts();
      const mgr = new AudioPipelineManager(opts);
      const { connection } = createMockConnection();

      await mgr.startPipeline('g1', connection);

      expect(opts.mockStt.start).toHaveBeenCalled();
      expect(mgr.hasPipeline('g1')).toBe(true);
      expect(mgr.activePipelineCount).toBe(1);
    });

    it('stopPipeline stops receiver and STT', async () => {
      const opts = createPipelineOpts();
      const mgr = new AudioPipelineManager(opts);
      const { connection } = createMockConnection();

      await mgr.startPipeline('g1', connection);
      await mgr.stopPipeline('g1');

      expect(opts.mockStt.stop).toHaveBeenCalled();
      expect(mgr.hasPipeline('g1')).toBe(false);
      expect(mgr.activePipelineCount).toBe(0);
    });

    it('stopPipeline is a no-op for unknown guild', async () => {
      const opts = createPipelineOpts();
      const mgr = new AudioPipelineManager(opts);

      // Should not throw
      await mgr.stopPipeline('unknown');
      expect(mgr.activePipelineCount).toBe(0);
    });

    it('startPipeline stops existing pipeline before restarting', async () => {
      const stts: ReturnType<typeof createMockStt>[] = [];
      const opts = createPipelineOpts({
        createStt: () => {
          const stt = createMockStt();
          stts.push(stt);
          return stt;
        },
      });
      const mgr = new AudioPipelineManager(opts);
      const { connection } = createMockConnection();

      await mgr.startPipeline('g1', connection);
      await mgr.startPipeline('g1', connection);

      // First STT should have been stopped
      expect(stts[0].stop).toHaveBeenCalled();
      // Second STT should be started
      expect(stts[1].start).toHaveBeenCalled();
      expect(mgr.activePipelineCount).toBe(1);
    });

    it('logs error and does not add pipeline if STT start fails', async () => {
      const log = createLogger();
      const failingStt = createMockStt();
      failingStt.start.mockRejectedValue(new Error('stt connect failed'));
      const mgr = new AudioPipelineManager({
        log,
        voiceConfig: baseVoiceConfig(),
        allowedUserIds: new Set(['111']),
        createDecoder: () => createMockDecoder(),
        createStt: () => failingStt,
      });
      const { connection } = createMockConnection();

      await mgr.startPipeline('g1', connection);

      expect(mgr.hasPipeline('g1')).toBe(false);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1' }),
        'failed to start audio pipeline',
      );
    });

    it('logs error if STT stop throws but still removes pipeline', async () => {
      const log = createLogger();
      const stt = createMockStt();
      stt.stop.mockRejectedValue(new Error('stop failed'));
      const mgr = new AudioPipelineManager({
        log,
        voiceConfig: baseVoiceConfig(),
        allowedUserIds: new Set(['111']),
        createDecoder: () => createMockDecoder(),
        createStt: () => stt,
      });
      const { connection } = createMockConnection();

      await mgr.startPipeline('g1', connection);
      await mgr.stopPipeline('g1');

      expect(mgr.hasPipeline('g1')).toBe(false);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1' }),
        'error stopping STT provider',
      );
    });
  });

  describe('attach', () => {
    it('starts pipeline when connection transitions to Ready', async () => {
      const opts = createPipelineOpts();
      const mgr = new AudioPipelineManager(opts);
      const { connection, _transition } = createMockConnection();

      mgr.attach('g1', connection);
      _transition('ready');

      // Allow async handler to settle
      await vi.waitFor(() => {
        expect(opts.mockStt.start).toHaveBeenCalled();
      });
      expect(mgr.hasPipeline('g1')).toBe(true);
    });

    it('stops pipeline when connection transitions to Destroyed', async () => {
      const opts = createPipelineOpts();
      const mgr = new AudioPipelineManager(opts);
      const { connection, _transition } = createMockConnection();

      mgr.attach('g1', connection);
      _transition('ready');

      await vi.waitFor(() => {
        expect(mgr.hasPipeline('g1')).toBe(true);
      });

      _transition('destroyed');

      await vi.waitFor(() => {
        expect(mgr.hasPipeline('g1')).toBe(false);
      });
      expect(opts.mockStt.stop).toHaveBeenCalled();
    });

    it('ignores non-Ready/Destroyed transitions', async () => {
      const opts = createPipelineOpts();
      const mgr = new AudioPipelineManager(opts);
      const { connection, _transition } = createMockConnection();

      mgr.attach('g1', connection);
      _transition('connecting');

      // Give it a tick to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(mgr.hasPipeline('g1')).toBe(false);
      expect(opts.mockStt.start).not.toHaveBeenCalled();
    });
  });

  describe('stopAll', () => {
    it('stops all active pipelines', async () => {
      const stts: ReturnType<typeof createMockStt>[] = [];
      const mgr = new AudioPipelineManager({
        log: createLogger(),
        voiceConfig: baseVoiceConfig(),
        allowedUserIds: new Set(['111']),
        createDecoder: () => createMockDecoder(),
        createStt: () => {
          const stt = createMockStt();
          stts.push(stt);
          return stt;
        },
      });

      const { connection: conn1 } = createMockConnection();
      const { connection: conn2 } = createMockConnection();

      await mgr.startPipeline('g1', conn1);
      await mgr.startPipeline('g2', conn2);

      expect(mgr.activePipelineCount).toBe(2);

      await mgr.stopAll();

      expect(mgr.activePipelineCount).toBe(0);
      expect(stts[0].stop).toHaveBeenCalled();
      expect(stts[1].stop).toHaveBeenCalled();
    });

    it('is a no-op when no pipelines are active', async () => {
      const mgr = new AudioPipelineManager(createPipelineOpts());
      await mgr.stopAll(); // should not throw
      expect(mgr.activePipelineCount).toBe(0);
    });
  });

  describe('onTranscription callback', () => {
    it('forwards transcription results with guildId', async () => {
      const transcriptions: { guildId: string; result: TranscriptionResult }[] = [];
      const stt = createMockStt();
      const mgr = new AudioPipelineManager({
        log: createLogger(),
        voiceConfig: baseVoiceConfig(),
        allowedUserIds: new Set(['111']),
        createDecoder: () => createMockDecoder(),
        createStt: () => stt,
        onTranscription: (guildId, result) => {
          transcriptions.push({ guildId, result });
        },
      });

      const { connection } = createMockConnection();
      await mgr.startPipeline('g1', connection);

      // STT onTranscription should have been wired up
      expect(stt.onTranscription).toHaveBeenCalled();

      // Simulate a transcription from the STT provider
      const result: TranscriptionResult = {
        text: 'hello world',
        isFinal: true,
        confidence: 0.95,
      };
      stt.transcriptionCb!(result);

      expect(transcriptions).toHaveLength(1);
      expect(transcriptions[0]).toEqual({ guildId: 'g1', result });
    });

    it('does not wire onTranscription when no callback is provided', async () => {
      const stt = createMockStt();
      const mgr = new AudioPipelineManager({
        log: createLogger(),
        voiceConfig: baseVoiceConfig(),
        allowedUserIds: new Set(['111']),
        createDecoder: () => createMockDecoder(),
        createStt: () => stt,
      });

      const { connection } = createMockConnection();
      await mgr.startPipeline('g1', connection);

      expect(stt.onTranscription).not.toHaveBeenCalled();
    });
  });

  describe('hasPipeline / activePipelineCount', () => {
    it('returns false and 0 when empty', () => {
      const mgr = new AudioPipelineManager(createPipelineOpts());
      expect(mgr.hasPipeline('g1')).toBe(false);
      expect(mgr.activePipelineCount).toBe(0);
    });

    it('reflects active pipelines', async () => {
      const stts: ReturnType<typeof createMockStt>[] = [];
      const mgr = new AudioPipelineManager({
        log: createLogger(),
        voiceConfig: baseVoiceConfig(),
        allowedUserIds: new Set(['111']),
        createDecoder: () => createMockDecoder(),
        createStt: () => {
          const stt = createMockStt();
          stts.push(stt);
          return stt;
        },
      });

      const { connection: conn1 } = createMockConnection();
      const { connection: conn2 } = createMockConnection();

      await mgr.startPipeline('g1', conn1);
      expect(mgr.hasPipeline('g1')).toBe(true);
      expect(mgr.activePipelineCount).toBe(1);

      await mgr.startPipeline('g2', conn2);
      expect(mgr.hasPipeline('g2')).toBe(true);
      expect(mgr.activePipelineCount).toBe(2);

      await mgr.stopPipeline('g1');
      expect(mgr.hasPipeline('g1')).toBe(false);
      expect(mgr.activePipelineCount).toBe(1);
    });
  });
});
