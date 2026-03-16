import { lookup } from 'node:dns/promises';

/**
 * Minimal SSRF safety layer for public image URLs.
 *
 * Validates that a URL:
 *  1. Uses http or https scheme
 *  2. Does not target a private/reserved hostname or IP
 *  3. Does not resolve (via DNS) to a private/reserved IP
 *
 * This prevents the bot from being used to probe internal networks.
 */

// ---------------------------------------------------------------------------
// Private / reserved IP detection
// ---------------------------------------------------------------------------

/**
 * Check whether an IPv4 address string falls in a private or reserved range.
 *
 * Blocked ranges (RFC 1918 / RFC 5735 / RFC 6598 / RFC 3927):
 *  - 10.0.0.0/8
 *  - 172.16.0.0/12
 *  - 192.168.0.0/16
 *  - 127.0.0.0/8    (loopback)
 *  - 169.254.0.0/16 (link-local)
 *  - 100.64.0.0/10  (CGNAT / shared address space)
 *  - 0.0.0.0/8      (current network)
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;

  if (a === 10) return true;                                   // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;            // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                     // 192.168.0.0/16
  if (a === 127) return true;                                  // 127.0.0.0/8
  if (a === 169 && b === 254) return true;                     // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;           // 100.64.0.0/10
  if (a === 0) return true;                                    // 0.0.0.0/8

  return false;
}

/**
 * Check whether an IPv6 address string is loopback, link-local, or unique-local.
 * Also catches IPv4-mapped IPv6 addresses (::ffff:x.x.x.x).
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback ::1
  if (normalized === '::1') return true;

  // Link-local fe80::/10
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe80%')) return true;

  // Unique-local fc00::/7 (fc00:: through fdff::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // IPv4-mapped ::ffff:x.x.x.x
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);

  return false;
}

/** Check if a string looks like an IPv4 literal. */
function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Check if a string looks like an IPv6 literal (bracket-stripped). */
function isIPv6Literal(host: string): boolean {
  return host.includes(':');
}

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
]);

const BLOCKED_SUFFIXES = [
  '.local',
  '.internal',
  '.localhost',
];

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  return BLOCKED_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type UrlSafetyResult =
  | { safe: true }
  | { safe: false; reason: string };

/**
 * Validate a URL for safe external image fetching.
 *
 * Checks scheme, hostname, literal IP, and DNS resolution.
 * Call this *before* fetching to prevent SSRF.
 */
export async function validateImageUrl(url: string): Promise<UrlSafetyResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'invalid URL' };
  }

  // Scheme check
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { safe: false, reason: 'only http(s) URLs are allowed' };
  }

  const hostname = parsed.hostname;

  // Empty hostname
  if (!hostname) {
    return { safe: false, reason: 'missing hostname' };
  }

  // Blocked hostname patterns
  if (isBlockedHostname(hostname)) {
    return { safe: false, reason: 'private/internal hosts are not allowed' };
  }

  // Strip IPv6 brackets for analysis
  const bareHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // Literal IPv4 check
  if (isIPv4Literal(bareHost)) {
    if (isPrivateIPv4(bareHost)) {
      return { safe: false, reason: 'private/internal hosts are not allowed' };
    }
    return { safe: true };
  }

  // Literal IPv6 check
  if (isIPv6Literal(bareHost)) {
    if (isPrivateIPv6(bareHost)) {
      return { safe: false, reason: 'private/internal hosts are not allowed' };
    }
    return { safe: true };
  }

  // DNS resolution check — resolve hostname and verify the IP is public.
  try {
    const { address, family } = await lookup(hostname);
    if (family === 4 && isPrivateIPv4(address)) {
      return { safe: false, reason: 'hostname resolves to a private/internal IP' };
    }
    if (family === 6 && isPrivateIPv6(address)) {
      return { safe: false, reason: 'hostname resolves to a private/internal IP' };
    }
  } catch {
    // DNS failure — hostname doesn't resolve. Let fetch handle the error
    // rather than blocking here, since transient DNS issues shouldn't
    // permanently reject a URL.
  }

  return { safe: true };
}
