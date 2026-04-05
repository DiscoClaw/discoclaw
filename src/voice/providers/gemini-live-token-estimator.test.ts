import { describe, it, expect } from 'vitest';
import { GeminiLiveTokenEstimator } from './gemini-live-token-estimator.js';

describe('GeminiLiveTokenEstimator', () => {
  // -----------------------------------------------------------------------
  // addText
  // -----------------------------------------------------------------------

  describe('addText', () => {
    it('estimates tokens at ~4 chars per token', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addText('Hello world!'); // 12 chars -> ceil(12/4) = 3 tokens
      expect(est.estimate.textTokens).toBe(3);
      expect(est.estimate.total).toBe(3);
    });

    it('rounds up partial tokens', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addText('Hi'); // 2 chars -> ceil(2/4) = 1 token
      expect(est.estimate.textTokens).toBe(1);
    });

    it('accumulates across multiple calls', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addText('aaaa'); // 4 chars -> 1 token
      est.addText('bbbbbbbb'); // 8 chars -> 2 tokens
      expect(est.estimate.textTokens).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // addInputAudio
  // -----------------------------------------------------------------------

  describe('addInputAudio', () => {
    it('estimates tokens from 16kHz mono PCM bytes', () => {
      const est = new GeminiLiveTokenEstimator();
      // 1 second of 16kHz mono PCM s16le = 32000 bytes -> 25 tokens
      est.addInputAudio(32_000);
      expect(est.estimate.audioTokens).toBe(25);
    });

    it('rounds up partial seconds', () => {
      const est = new GeminiLiveTokenEstimator();
      // 100 bytes -> 100/32000 ~= 0.003s -> ceil(0.003 * 25) = 1 token
      est.addInputAudio(100);
      expect(est.estimate.audioTokens).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // addOutputAudio
  // -----------------------------------------------------------------------

  describe('addOutputAudio', () => {
    it('estimates tokens from 24kHz mono PCM bytes', () => {
      const est = new GeminiLiveTokenEstimator();
      // 1 second of 24kHz mono PCM s16le = 48000 bytes -> 25 tokens
      est.addOutputAudio(48_000);
      expect(est.estimate.audioTokens).toBe(25);
    });
  });

  // -----------------------------------------------------------------------
  // addToolCall / addToolResponse
  // -----------------------------------------------------------------------

  describe('addToolCall', () => {
    it('estimates tokens from function name + serialised args', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addToolCall('web_search', { query: 'hello' });
      // payload = 'web_search{"query":"hello"}' -> 27 chars -> ceil(27/4) = 7
      expect(est.estimate.toolTokens).toBe(7);
    });
  });

  describe('addToolResponse', () => {
    it('estimates tokens from response output', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addToolResponse('some result text'); // 16 chars -> ceil(16/4) = 4
      expect(est.estimate.toolTokens).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // estimate
  // -----------------------------------------------------------------------

  describe('estimate', () => {
    it('returns combined total of text, audio, and tool tokens', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addText('test'); // 1 token
      est.addInputAudio(32_000); // 25 tokens
      est.addToolCall('x', {}); // 'x{}' -> ceil(3/4) = 1 token
      expect(est.estimate).toEqual({
        textTokens: 1,
        audioTokens: 25,
        toolTokens: 1,
        total: 27,
      });
    });
  });

  // -----------------------------------------------------------------------
  // threshold checking
  // -----------------------------------------------------------------------

  describe('threshold checking', () => {
    it('returns null when below warn threshold', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 100 });
      est.addText('hi'); // 1 token
      expect(est.checkThreshold()).toBeNull();
    });

    it('returns "warn" when crossing the warn threshold', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 2, compressAt: 100 });
      est.addText('12345678'); // ceil(8/4) = 2 tokens
      expect(est.checkThreshold()).toBe('warn');
    });

    it('returns "warn" only once per threshold crossing', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 2, compressAt: 100 });
      est.addText('12345678'); // 2 tokens -> crosses warn
      expect(est.checkThreshold()).toBe('warn');
      est.addText('more');
      expect(est.checkThreshold()).toBeNull();
    });

    it('returns "compress" when crossing the compress threshold', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 2, compressAt: 5 });
      est.addText('12345678901234567890'); // ceil(20/4) = 5 tokens
      expect(est.checkThreshold()).toBe('compress');
    });

    it('skips "warn" if compress fires first', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 2, compressAt: 3 });
      est.addText('123456789012'); // ceil(12/4) = 3 tokens -> crosses both
      expect(est.checkThreshold()).toBe('compress');
      expect(est.checkThreshold()).toBeNull();
    });

    it('shouldWarn reflects threshold state', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 2 });
      expect(est.shouldWarn).toBe(false);
      est.addText('12345678'); // 2 tokens
      expect(est.shouldWarn).toBe(true);
    });

    it('shouldCompress reflects threshold state', () => {
      const est = new GeminiLiveTokenEstimator({ compressAt: 2 });
      expect(est.shouldCompress).toBe(false);
      est.addText('12345678'); // 2 tokens
      expect(est.shouldCompress).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('clears all token counters', () => {
      const est = new GeminiLiveTokenEstimator();
      est.addText('hello');
      est.addInputAudio(32_000);
      est.addToolCall('fn', {});
      est.reset();
      expect(est.estimate).toEqual({
        textTokens: 0,
        audioTokens: 0,
        toolTokens: 0,
        total: 0,
      });
    });

    it('re-arms threshold notifications after reset', () => {
      const est = new GeminiLiveTokenEstimator({ warnAt: 2, compressAt: 100 });
      est.addText('12345678'); // 2 tokens -> crosses warn
      expect(est.checkThreshold()).toBe('warn');

      est.reset();
      est.addText('12345678'); // 2 tokens again -> warn fires again
      expect(est.checkThreshold()).toBe('warn');
    });
  });
});
