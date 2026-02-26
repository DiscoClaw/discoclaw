import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpusDecoder } from './audio-receiver.js';

// ---------------------------------------------------------------------------
// Mock @discordjs/opus — the native addon may not be available in CI/test.
// ---------------------------------------------------------------------------

const mockDecode = vi.fn();

const MockOpusEncoder = vi.fn().mockImplementation(() => ({
  decode: mockDecode,
  encode: vi.fn(),
}));

vi.mock('@discordjs/opus', () => ({
  default: { OpusEncoder: MockOpusEncoder },
  OpusEncoder: MockOpusEncoder,
}));

// Import after mock is set up
const { createOpusDecoder, opusDecoderFactory } = await import('./opus.js');
const { OpusEncoder } = await import('@discordjs/opus');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createOpusDecoder', () => {
  it('creates an OpusEncoder with 48 kHz stereo', () => {
    createOpusDecoder();
    expect(OpusEncoder).toHaveBeenCalledWith(48_000, 2);
  });

  it('returns an object with decode and destroy methods', () => {
    const decoder = createOpusDecoder();
    expect(typeof decoder.decode).toBe('function');
    expect(typeof decoder.destroy).toBe('function');
  });

  it('decode delegates to the underlying OpusEncoder.decode', () => {
    const pcmResult = Buffer.alloc(3840);
    mockDecode.mockReturnValueOnce(pcmResult);

    const decoder = createOpusDecoder();
    const packet = Buffer.from([0x01, 0x02, 0x03]);
    const result = decoder.decode(packet);

    expect(mockDecode).toHaveBeenCalledWith(packet);
    expect(result).toBe(pcmResult);
  });

  it('throws after destroy is called', () => {
    const decoder = createOpusDecoder();
    decoder.destroy();

    expect(() => decoder.decode(Buffer.from([0x01]))).toThrow(
      'OpusDecoder has been destroyed',
    );
  });

  it('destroy can be called multiple times without error', () => {
    const decoder = createOpusDecoder();
    decoder.destroy();
    decoder.destroy(); // should not throw
  });

  it('each call creates an independent decoder', () => {
    const d1 = createOpusDecoder();
    const d2 = createOpusDecoder();

    expect(OpusEncoder).toHaveBeenCalledTimes(2);

    // Destroying one should not affect the other
    d1.destroy();
    expect(() => d1.decode(Buffer.from([0x01]))).toThrow();

    mockDecode.mockReturnValueOnce(Buffer.alloc(10));
    expect(() => d2.decode(Buffer.from([0x01]))).not.toThrow();
  });

  it('satisfies the OpusDecoder interface', () => {
    const decoder: OpusDecoder = createOpusDecoder();
    expect(decoder).toBeDefined();
  });
});

describe('opusDecoderFactory', () => {
  it('is a function that returns an OpusDecoder', () => {
    expect(typeof opusDecoderFactory).toBe('function');
    const decoder = opusDecoderFactory();
    expect(typeof decoder.decode).toBe('function');
    expect(typeof decoder.destroy).toBe('function');
  });

  it('creates a new decoder on each call', () => {
    vi.mocked(OpusEncoder).mockClear();
    const d1 = opusDecoderFactory();
    const d2 = opusDecoderFactory();
    expect(OpusEncoder).toHaveBeenCalledTimes(2);
    expect(d1).not.toBe(d2);
  });
});
