/**
 * Focused tests for prototype-pollution defence on the webhook ingress route.
 *
 * Ensures that POST /webhook/__proto__ (and siblings) returns a normal 400
 * instead of crashing the server, while valid providers still work.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  startWebhookServer,
  type WebhookConfig,
  type WebhookServerOptions,
} from '../src/webhook/server.js';
import { executeCronJob } from '../src/cron/executor.js';

vi.mock('../src/cron/executor.js', () => ({
  executeCronJob: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signBody(body: string | Buffer, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return 'sha256=' + hmac.digest('hex');
}

type Response = {
  status: number;
  body: { ok: boolean; message: string };
};

function makeRequest(
  port: number,
  opts: { method?: string; path?: string; body?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const rawBody = opts.body ?? '';
    const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path ?? '/',
        method: opts.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(new Error(`Failed to parse response body: ${text}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Prototype-pollution route params
// ---------------------------------------------------------------------------

describe('webhook prototype-pollution defence', () => {
  let tmpDir: string;
  let port: number;
  let handle: Awaited<ReturnType<typeof startWebhookServer>>;

  const config: WebhookConfig = {
    github: { secret: 'gh-secret', channel: 'deploys' },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-proto-'));
    const configPath = path.join(tmpDir, 'webhooks.json');
    await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
    handle = await startWebhookServer({
      configPath,
      port: 0,
      host: '127.0.0.1',
      guildId: 'guild-1',
      executorCtx: {} as any,
      log: mockLog(),
    });
    const addr = handle.server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await handle.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects __proto__ with 400 and does not crash', async () => {
    const res = await makeRequest(port, { path: '/webhook/__proto__', body: '{}' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects constructor with 400', async () => {
    const res = await makeRequest(port, { path: '/webhook/constructor', body: '{}' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects prototype with 400', async () => {
    const res = await makeRequest(port, { path: '/webhook/prototype', body: '{}' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects percent-encoded __proto__ (%5f%5fproto%5f%5f) with 400', async () => {
    const res = await makeRequest(port, { path: '/webhook/%5f%5fproto%5f%5f', body: '{}' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects percent-encoded constructor (%63onstructor) with 400', async () => {
    const res = await makeRequest(port, { path: '/webhook/%63onstructor', body: '{}' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('never calls executeCronJob for pollution keys', async () => {
    await makeRequest(port, { path: '/webhook/__proto__', body: '{}' });
    await makeRequest(port, { path: '/webhook/constructor', body: '{}' });
    await makeRequest(port, { path: '/webhook/prototype', body: '{}' });
    await tick();
    expect(vi.mocked(executeCronJob)).not.toHaveBeenCalled();
  });

  it('still accepts a valid provider after rejecting pollution keys', async () => {
    // First send a pollution attempt
    const bad = await makeRequest(port, { path: '/webhook/__proto__', body: '{}' });
    expect(bad.status).toBe(400);

    // Then send a valid request — server must still be healthy
    const body = '{"event":"push"}';
    const good = await makeRequest(port, {
      path: '/webhook/github',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'gh-secret') },
    });
    expect(good.status).toBe(202);
    expect(good.body.ok).toBe(true);
  });

  it('rejects malformed percent-encoding with 400 (not a crash)', async () => {
    const res = await makeRequest(port, { path: '/webhook/%GG' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 404 (not 500) for an unknown but safe source', async () => {
    const body = '{}';
    const res = await makeRequest(port, {
      path: '/webhook/no-such-source',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'any') },
    });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
