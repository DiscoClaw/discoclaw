type ErrnoLike = {
  code?: unknown;
};

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as ErrnoLike).code === code;
}

export function mapListenError(err: unknown, port: number): Error {
  if (hasErrorCode(err, 'EADDRINUSE')) {
    return new Error(
      `Dashboard port ${port} is already in use. Another DiscoClaw instance may already be running with the dashboard enabled. Set DISCOCLAW_DASHBOARD_PORT to a different port for one instance, or disable the dashboard on one of them.`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (hasErrorCode(err, 'EACCES')) {
    return new Error(
      `Dashboard port ${port} requires elevated privileges. Use a port above 1024, or set DISCOCLAW_DASHBOARD_PORT to a non-privileged port.`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (err instanceof Error) return err;
  return new Error(String(err));
}
