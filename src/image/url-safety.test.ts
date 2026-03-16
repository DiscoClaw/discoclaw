import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup } from 'node:dns/promises';
import { isPrivateIPv4, isPrivateIPv6, validateImageUrl } from './url-safety.js';

const mockLookup = vi.mocked(lookup);

beforeEach(() => {
  mockLookup.mockReset();
  // Default: resolve to a public IP
  mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 } as any);
});

// ---------------------------------------------------------------------------
// isPrivateIPv4
// ---------------------------------------------------------------------------

describe('isPrivateIPv4', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    ['192.167.0.1', false],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['169.254.0.1', true],
    ['169.254.169.254', true],
    ['169.253.0.1', false],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.63.0.1', false],
    ['100.128.0.1', false],
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['1.1.1.1', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });

  it('rejects malformed IPs', () => {
    expect(isPrivateIPv4('not-an-ip')).toBe(false);
    expect(isPrivateIPv4('256.0.0.1')).toBe(false);
    expect(isPrivateIPv4('10.0.0')).toBe(false);
    expect(isPrivateIPv4('')).toBe(false);
    expect(isPrivateIPv4('10.0.0.1.2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIPv6
// ---------------------------------------------------------------------------

describe('isPrivateIPv6', () => {
  it('detects loopback ::1', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('detects link-local fe80::', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('FE80::1')).toBe(true);
  });

  it('detects unique-local fc00::/7', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
    expect(isPrivateIPv6('fdff::1')).toBe(true);
    expect(isPrivateIPv6('FD12:3456:789a::1')).toBe(true);
  });

  it('detects IPv4-mapped private addresses', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
  });

  it('allows IPv4-mapped public addresses', () => {
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isPrivateIPv6('2001:db8::1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateImageUrl
// ---------------------------------------------------------------------------

describe('validateImageUrl', () => {
  it('allows valid https URL', async () => {
    const result = await validateImageUrl('https://example.com/photo.png');
    expect(result.safe).toBe(true);
  });

  it('allows valid http URL', async () => {
    const result = await validateImageUrl('http://example.com/photo.png');
    expect(result.safe).toBe(true);
  });

  it('rejects ftp scheme', async () => {
    const result = await validateImageUrl('ftp://example.com/photo.png');
    expect(result).toEqual({ safe: false, reason: 'only http(s) URLs are allowed' });
  });

  it('rejects data: scheme', async () => {
    const result = await validateImageUrl('data:image/png;base64,abc');
    expect(result).toEqual({ safe: false, reason: 'only http(s) URLs are allowed' });
  });

  it('rejects invalid URL', async () => {
    const result = await validateImageUrl('not-a-url');
    expect(result).toEqual({ safe: false, reason: 'invalid URL' });
  });

  // Blocked hostnames
  it('rejects localhost', async () => {
    const result = await validateImageUrl('http://localhost/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects localhost.localdomain', async () => {
    const result = await validateImageUrl('http://localhost.localdomain/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects .local suffix', async () => {
    const result = await validateImageUrl('http://myserver.local/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects .internal suffix', async () => {
    const result = await validateImageUrl('http://myserver.internal/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects .localhost suffix', async () => {
    const result = await validateImageUrl('http://foo.localhost/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  // Literal private IPv4
  it('rejects literal 127.0.0.1', async () => {
    const result = await validateImageUrl('http://127.0.0.1/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects literal 10.0.0.1', async () => {
    const result = await validateImageUrl('http://10.0.0.1/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects literal 192.168.1.1', async () => {
    const result = await validateImageUrl('http://192.168.1.1/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects literal 169.254.169.254 (cloud metadata)', async () => {
    const result = await validateImageUrl('http://169.254.169.254/latest/meta-data/');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  // Literal public IPv4
  it('allows literal public IPv4', async () => {
    const result = await validateImageUrl('http://93.184.216.34/photo.png');
    expect(result.safe).toBe(true);
  });

  // Literal IPv6
  it('rejects literal ::1', async () => {
    const result = await validateImageUrl('http://[::1]/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  it('rejects literal fe80::1', async () => {
    const result = await validateImageUrl('http://[fe80::1]/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  // DNS resolution to private IP
  it('rejects hostname resolving to private IPv4', async () => {
    mockLookup.mockResolvedValue({ address: '192.168.1.100', family: 4 } as any);
    const result = await validateImageUrl('https://evil.example.com/photo.png');
    expect(result).toEqual({ safe: false, reason: 'hostname resolves to a private/internal IP' });
  });

  it('rejects hostname resolving to loopback', async () => {
    mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 } as any);
    const result = await validateImageUrl('https://evil.example.com/photo.png');
    expect(result).toEqual({ safe: false, reason: 'hostname resolves to a private/internal IP' });
  });

  it('rejects hostname resolving to private IPv6', async () => {
    mockLookup.mockResolvedValue({ address: '::1', family: 6 } as any);
    const result = await validateImageUrl('https://evil.example.com/photo.png');
    expect(result).toEqual({ safe: false, reason: 'hostname resolves to a private/internal IP' });
  });

  it('rejects hostname resolving to unique-local IPv6 (fc00::/7)', async () => {
    mockLookup.mockResolvedValue({ address: 'fd00::1', family: 6 } as any);
    const result = await validateImageUrl('https://evil.example.com/photo.png');
    expect(result).toEqual({ safe: false, reason: 'hostname resolves to a private/internal IP' });
  });

  it('rejects literal unique-local IPv6', async () => {
    const result = await validateImageUrl('http://[fd00::1]/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });

  // DNS failure — allow through (let fetch handle it)
  it('allows URL when DNS lookup fails (transient error)', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await validateImageUrl('https://maybe-down.example.com/photo.png');
    expect(result.safe).toBe(true);
  });

  // Hostname is case-insensitive
  it('rejects LOCALHOST (case-insensitive)', async () => {
    const result = await validateImageUrl('http://LOCALHOST/image.png');
    expect(result).toEqual({ safe: false, reason: 'private/internal hosts are not allowed' });
  });
});
