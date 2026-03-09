type ErrnoLike = {
  code?: unknown;
};

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as ErrnoLike).code === code;
}

function formatListenTarget(host: string, port: number): string {
  return `${host}:${port}`;
}

export function mapListenError(err: unknown, host: string, port: number): Error {
  const target = formatListenTarget(host, port);

  if (hasErrorCode(err, 'EADDRINUSE')) {
    return new Error(
      `Dashboard failed to bind ${target} because the port is already in use. Another DiscoClaw instance may already be running with the dashboard enabled. Set DISCOCLAW_DASHBOARD_PORT to a different port in .env for one instance (for example, 9402), or disable the dashboard on one of them.`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (hasErrorCode(err, 'EACCES')) {
    return new Error(
      `Dashboard failed to bind ${target} because it requires elevated privileges. Use a port above 1024, or set DISCOCLAW_DASHBOARD_PORT to a non-privileged port in .env.`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (err instanceof Error) return err;
  return new Error(String(err));
}
