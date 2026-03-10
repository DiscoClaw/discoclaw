export const DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 9401;

export type DashboardListenAddress = {
  address?: string;
  port?: number;
} | null | undefined;

export function formatDashboardUrl(host: string, port: number): string {
  return `http://${host}:${port}/`;
}

export function formatDashboardListenUrl(
  address: DashboardListenAddress,
  fallbackHost: string,
  fallbackPort: number,
): string {
  return formatDashboardUrl(address?.address ?? fallbackHost, address?.port ?? fallbackPort);
}

export function formatDashboardOperatorUrl(
  address: DashboardListenAddress,
  fallbackPort: number,
): string {
  return formatDashboardUrl(DASHBOARD_HOST, address?.port ?? fallbackPort);
}

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

export function parseDashboardTrustedHosts(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.DISCOCLAW_DASHBOARD_TRUSTED_HOSTS?.trim();
  if (!raw) return new Set();

  const trustedHosts = new Set<string>();
  for (const entry of raw.split(',')) {
    const value = entry.trim().toLowerCase().replace(/\.+$/, '');
    if (!value) continue;
    if (value.includes(':')) {
      throw new Error(
        'DISCOCLAW_DASHBOARD_TRUSTED_HOSTS does not support IPv6 literals. Use hostnames or IPv4 addresses only; see the dashboard docs for supported values.',
      );
    }
    trustedHosts.add(value);
  }
  return trustedHosts;
}

export function resolveDashboardBindHost(trustedHosts: Set<string>): string {
  return trustedHosts.size > 0 ? '0.0.0.0' : DASHBOARD_HOST;
}
