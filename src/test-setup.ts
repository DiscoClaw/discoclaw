import { afterEach, vi } from 'vitest';

// After each test: clear accumulated mock call/result history to prevent
// monotonic memory growth across tests within a worker.
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Safety net: restore real timers if a test used vi.useFakeTimers() but
  // failed or threw before its own cleanup ran.
  vi.useRealTimers();
});
