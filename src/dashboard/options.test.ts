import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_HOST,
  formatDashboardListenUrl,
  formatDashboardUrl,
  parseDashboardPort,
  parseDashboardTrustedHosts,
  resolveDashboardBindHost,
} from './options.js';

describe('dashboard options', () => {
  it('parses the dashboard port from env', () => {
    expect(parseDashboardPort({ DISCOCLAW_DASHBOARD_PORT: '9500' } as NodeJS.ProcessEnv)).toBe(9500);
  });

  it('normalizes trusted hosts from env', () => {
    expect(parseDashboardTrustedHosts({
      DISCOCLAW_DASHBOARD_TRUSTED_HOSTS: ' Phone.Tailnet.ts.net.,100.64.0.12,,LOCALHOST. ',
    } as NodeJS.ProcessEnv)).toEqual(new Set(['phone.tailnet.ts.net', '100.64.0.12', 'localhost']));
  });

  it('rejects IPv6 trusted hosts', () => {
    expect(() => parseDashboardTrustedHosts({
      DISCOCLAW_DASHBOARD_TRUSTED_HOSTS: 'fd7a:115c:a1e0::1',
    } as NodeJS.ProcessEnv)).toThrow(
      'DISCOCLAW_DASHBOARD_TRUSTED_HOSTS does not support IPv6 literals. Use hostnames or IPv4 addresses only; see the dashboard docs for supported values.',
    );
  });

  it('resolves the dashboard bind host from trusted hosts', () => {
    expect(resolveDashboardBindHost(new Set())).toBe(DASHBOARD_HOST);
    expect(resolveDashboardBindHost(new Set(['phone.tailnet.ts.net']))).toBe('0.0.0.0');
  });

  it('formats a dashboard URL from host and port', () => {
    expect(formatDashboardUrl('127.0.0.1', 9401)).toBe('http://127.0.0.1:9401/');
  });

  it('formats the published dashboard URL from the bound listen address', () => {
    expect(formatDashboardListenUrl({ address: '0.0.0.0', port: 9500 }, DASHBOARD_HOST, 9401))
      .toBe('http://0.0.0.0:9500/');
    expect(formatDashboardListenUrl(undefined, DASHBOARD_HOST, 9401))
      .toBe('http://127.0.0.1:9401/');
  });
});
