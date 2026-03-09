import { describe, expect, it } from 'vitest';
import { mapListenError } from './server-errors.js';

describe('dashboard server listen errors', () => {
  it('maps EADDRINUSE to an actionable port-conflict message', () => {
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });

    expect(mapListenError(err, '127.0.0.1', 9401).message).toBe(
      'Dashboard failed to bind 127.0.0.1:9401 because the port is already in use. Another DiscoClaw instance may already be running with the dashboard enabled. Set DISCOCLAW_DASHBOARD_PORT to a different port in .env for one instance (for example, 9402), or disable the dashboard on one of them.',
    );
  });

  it('maps EACCES to an actionable privileged-port message', () => {
    const err = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });

    expect(mapListenError(err, '127.0.0.1', 80).message).toBe(
      'Dashboard failed to bind 127.0.0.1:80 because it requires elevated privileges. Use a port above 1024, or set DISCOCLAW_DASHBOARD_PORT to a non-privileged port in .env.',
    );
  });

  it('passes unknown errors through unchanged', () => {
    const err = new Error('boom');

    expect(mapListenError(err, '127.0.0.1', 9401)).toBe(err);
  });
});
