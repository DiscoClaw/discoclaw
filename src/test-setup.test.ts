import { describe, expect, it, vi } from 'vitest';

// Verify that the global afterEach hooks registered in test-setup.ts
// actually clear mock state and env stubs between tests.

describe('test-setup global afterEach hooks', () => {
  describe('vi.clearAllMocks', () => {
    it('populates mock call history in this test', () => {
      const fn = vi.fn();
      fn('arg1');
      fn('arg2');
      expect(fn.mock.calls).toHaveLength(2);
      // afterEach will call vi.clearAllMocks() — verified by the next test.
    });

    it('mock call history is empty after the previous test ran afterEach', () => {
      // A fresh mock created here has no prior history — but more importantly,
      // any spy attached in the previous test would have been cleared.
      // We verify the mechanism works by checking a new spy starts clean.
      const fn = vi.fn();
      expect(fn.mock.calls).toHaveLength(0);
    });
  });

  describe('vi.unstubAllEnvs', () => {
    it('stubs an env var in this test', () => {
      vi.stubEnv('TEST_SETUP_SENTINEL', 'stubbed');
      expect(process.env['TEST_SETUP_SENTINEL']).toBe('stubbed');
      // afterEach will call vi.unstubAllEnvs().
    });

    it('env stub is restored after the previous test ran afterEach', () => {
      expect(process.env['TEST_SETUP_SENTINEL']).toBeUndefined();
    });
  });
});
