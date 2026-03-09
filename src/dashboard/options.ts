export const DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 9401;

export function parseDashboardPort(env: NodeJS.ProcessEnv): number {
  const raw = env.DISCOCLAW_DASHBOARD_PORT?.trim();
  if (!raw) return DEFAULT_DASHBOARD_PORT;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`DISCOCLAW_DASHBOARD_PORT must be a positive number, got "${raw}"`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`DISCOCLAW_DASHBOARD_PORT must be an integer, got "${raw}"`);
  }
  return value;
}
