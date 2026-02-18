import { describe, expect, it, vi } from 'vitest';

// Verify that the global afterEach hooks registered in test-setup.ts
// actually clear mock state and env stubs between tests.

// Shared spy — persists across it() blocks within this describe so the second
// test can confirm the first test's call history was cleared by afterEach.
const sharedSpy = vi.fn();

describe('test-setup global afterEach hooks', () => {
  describe('vi.clearAllMocks', () => {
    it('populates shared spy call history in this test', () => {
      sharedSpy('arg1');
      sharedSpy('arg2');
      expect(sharedSpy.mock.calls).toHaveLength(2);
      // afterEach will call vi.clearAllMocks() — verified by the next test.
    });

    it('shared spy call history is empty after the previous test ran afterEach', () => {
      // sharedSpy was called twice above; if clearAllMocks ran between tests
      // its call history must now be empty.
      expect(sharedSpy.mock.calls).toHaveLength(0);
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

  describe('vi.useRealTimers', () => {
    it('installs fake timers in this test', () => {
      vi.useFakeTimers();
      // Confirm fake timers are active: setTimeout should be the vitest stub.
      expect(vi.isFakeTimers()).toBe(true);
      // afterEach will call vi.useRealTimers() as a safety net.
    });

    it('real timers are restored after the previous test ran afterEach', () => {
      expect(vi.isFakeTimers()).toBe(false);
    });
  });
});
