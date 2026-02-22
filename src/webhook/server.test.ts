import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startWebhookServer, loadWebhookConfig, type WebhookConfig, type WebhookServerOptions } from './server.js';
import { executeCronJob } from '../cron/executor.js';

vi.mock('../cron/executor.js', () => ({
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

type RequestOptions = {
  method?: string;
  path?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
};

type Response = {
  status: number;
  body: { ok: boolean; message: string };
};

function makeRequest(port: number, opts: RequestOptions = {}): Promise<Response> {
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

// Give the fire-and-forget dispatch one event-loop tick to settle.
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// loadWebhookConfig
// ---------------------------------------------------------------------------

describe('loadWebhookConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-cfg-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid config file', async () => {
    const config: WebhookConfig = {
      github: { secret: 'abc123', channel: 'deploys' },
      alerts: { secret: 'xyz789', channel: 'ops', prompt: 'Handle alert' },
    };
    const cfgPath = path.join(tmpDir, 'webhooks.json');
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');

    const loaded = await loadWebhookConfig(cfgPath);
    expect(loaded).toEqual(config);
  });

  it('throws when file does not exist', async () => {
    await expect(loadWebhookConfig(path.join(tmpDir, 'missing.json'))).rejects.toThrow();
  });

  it('throws when JSON is invalid', async () => {
    const cfgPath = path.join(tmpDir, 'bad.json');
    await fs.writeFile(cfgPath, 'not json', 'utf8');
    await expect(loadWebhookConfig(cfgPath)).rejects.toThrow();
  });

  it('throws when config is an array', async () => {
    const cfgPath = path.join(tmpDir, 'array.json');
    await fs.writeFile(cfgPath, '[]', 'utf8');
    await expect(loadWebhookConfig(cfgPath)).rejects.toThrow('Webhook config must be a JSON object');
  });

  it('throws when config is a primitive', async () => {
    const cfgPath = path.join(tmpDir, 'prim.json');
    await fs.writeFile(cfgPath, '"hello"', 'utf8');
    await expect(loadWebhookConfig(cfgPath)).rejects.toThrow('Webhook config must be a JSON object');
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — HTTP routing
// ---------------------------------------------------------------------------

describe('startWebhookServer HTTP routing', () => {
  let tmpDir: string;
  let port: number;
  let handle: Awaited<ReturnType<typeof startWebhookServer>>;

  const config: WebhookConfig = {
    github: { secret: 'gh-secret', channel: 'deploys' },
    alerts: { secret: 'alert-secret', channel: 'ops', prompt: 'Alert received.' },
  };

  const baseOpts = (): Omit<WebhookServerOptions, 'configPath' | 'port'> => ({
    host: '127.0.0.1',
    guildId: 'guild-1',
    executorCtx: {} as any,
    log: mockLog(),
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-srv-'));
    const configPath = path.join(tmpDir, 'webhooks.json');
    await fs.writeFile(configPath, JSON.stringify(config), 'utf8');
    handle = await startWebhookServer({ ...baseOpts(), configPath, port: 0 });
    const addr = handle.server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await handle.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for paths that do not match /webhook/:source', async () => {
    const res = await makeRequest(port, { path: '/not-a-webhook' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('returns 404 for root path', async () => {
    const res = await makeRequest(port, { path: '/' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for /webhook/ with no source segment', async () => {
    const res = await makeRequest(port, { path: '/webhook/' });
    expect(res.status).toBe(404);
  });

  it('returns 405 for GET requests', async () => {
    const res = await makeRequest(port, { path: '/webhook/github', method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.body.ok).toBe(false);
  });

  it('returns 405 for PUT requests', async () => {
    const res = await makeRequest(port, { path: '/webhook/github', method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('returns 400 for a malformed percent-encoded source (%GG)', async () => {
    const res = await makeRequest(port, { path: '/webhook/%GG' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 for another malformed percent-encoding (foo%ZZbar)', async () => {
    const res = await makeRequest(port, { path: '/webhook/foo%ZZbar' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown source', async () => {
    const body = '{}';
    const res = await makeRequest(port, {
      path: '/webhook/unknown-source',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'any') },
    });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('returns 401 when the signature header is absent', async () => {
    const res = await makeRequest(port, { path: '/webhook/github', body: '{"event":"push"}' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('returns 401 for a malformed signature value', async () => {
    const res = await makeRequest(port, {
      path: '/webhook/github',
      body: '{"event":"push"}',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the signature uses the wrong secret', async () => {
    const body = '{"event":"push"}';
    const res = await makeRequest(port, {
      path: '/webhook/github',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'wrong-secret') },
    });
    expect(res.status).toBe(401);
  });

  it('returns 202 for a valid signed POST', async () => {
    const body = '{"event":"push"}';
    const res = await makeRequest(port, {
      path: '/webhook/github',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'gh-secret') },
    });
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
  });

  it('accepts a valid request with an empty body', async () => {
    const body = '';
    const res = await makeRequest(port, {
      path: '/webhook/github',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'gh-secret') },
    });
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — executeCronJob dispatch
// ---------------------------------------------------------------------------

describe('startWebhookServer dispatch', () => {
  let tmpDir: string;
  let port: number;
  let handle: Awaited<ReturnType<typeof startWebhookServer>>;

  const config: WebhookConfig = {
    github: { secret: 'gh-secret', channel: 'deploys' },
    alerts: { secret: 'alert-secret', channel: 'ops', prompt: 'Alert received.' },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-disp-'));
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

  async function postValid(source: 'github' | 'alerts', body = '{}') {
    const secret = source === 'github' ? 'gh-secret' : 'alert-secret';
    return makeRequest(port, {
      path: `/webhook/${source}`,
      body,
      headers: { 'x-hub-signature-256': signBody(body, secret) },
    });
  }

  it('calls executeCronJob once after a valid request', async () => {
    await postValid('github');
    await tick();
    expect(vi.mocked(executeCronJob)).toHaveBeenCalledOnce();
  });

  it('does not call executeCronJob for an invalid signature', async () => {
    await makeRequest(port, {
      path: '/webhook/github',
      body: '{}',
      headers: { 'x-hub-signature-256': 'sha256=invalid' },
    });
    await tick();
    expect(vi.mocked(executeCronJob)).not.toHaveBeenCalled();
  });

  it('dispatches job with correct guildId and channel', async () => {
    await postValid('github');
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.guildId).toBe('guild-1');
    expect(job.def.channel).toBe('deploys');
  });

  it('builds default prompt from source name and body when no custom prompt is set', async () => {
    const body = 'payload data here';
    await postValid('github', body);
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.def.prompt).toContain('github');
    expect(job.def.prompt).toContain('payload data here');
  });

  it('uses the custom prompt when one is configured', async () => {
    await postValid('alerts', '{"level":"warn"}');
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.def.prompt).toBe('Alert received.');
  });

  it('names the job with the source', async () => {
    await postValid('github');
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.name).toBe('webhook:github');
  });

  it('assigns a unique id to each dispatch', async () => {
    await postValid('github');
    await tick();
    await postValid('github');
    await tick();

    const calls = vi.mocked(executeCronJob).mock.calls;
    expect(calls).toHaveLength(2);
    const id0 = (calls[0][0] as any).id;
    const id1 = (calls[1][0] as any).id;
    expect(id0).not.toBe(id1);
  });

  it('leaves schedule undefined and sets timezone to UTC on the synthetic job', async () => {
    await postValid('github');
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.def.schedule).toBeUndefined();
    expect(job.def.timezone).toBe('UTC');
  });

  it('sets triggerType to webhook on the synthetic job', async () => {
    await postValid('github');
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.def.triggerType).toBe('webhook');
  });

  it('decodes a valid percent-encoded source name before looking it up', async () => {
    // 'alerts' with the first character 'a' encoded as %61
    const body = '{}';
    const res = await makeRequest(port, {
      path: '/webhook/%61lerts',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'alert-secret') },
    });
    expect(res.status).toBe(202);
    await tick();

    const [job] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(job.name).toBe('webhook:alerts');
  });

  it('passes the executorCtx through to executeCronJob', async () => {
    const executorCtx = { __marker: 'test-ctx' } as any;
    const cfgPath = path.join(tmpDir, 'webhooks2.json');
    await fs.writeFile(cfgPath, JSON.stringify(config), 'utf8');
    const h2 = await startWebhookServer({
      configPath: cfgPath,
      port: 0,
      host: '127.0.0.1',
      guildId: 'g2',
      executorCtx,
      log: mockLog(),
    });
    const p2 = (h2.server.address() as { port: number }).port;

    const body = '{}';
    await makeRequest(p2, {
      path: '/webhook/github',
      body,
      headers: { 'x-hub-signature-256': signBody(body, 'gh-secret') },
    });
    await tick();
    await h2.close();

    const [, ctx] = vi.mocked(executeCronJob).mock.calls[0] as [any, any];
    expect(ctx).toBe(executorCtx);
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — body size limit
// ---------------------------------------------------------------------------

describe('startWebhookServer body size limit', () => {
  let tmpDir: string;
  let port: number;
  let handle: Awaited<ReturnType<typeof startWebhookServer>>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-body-'));
    const configPath = path.join(tmpDir, 'webhooks.json');
    await fs.writeFile(configPath, JSON.stringify({ src: { secret: 's', channel: 'c' } }), 'utf8');
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

  it('returns 413 or closes connection for a 257 KB body, and never dispatches', async () => {
    const bigBody = Buffer.alloc(257 * 1024, 0x78); // 257 KB of 'x'
    let status: number | undefined;
    try {
      const res = await makeRequest(port, {
        path: '/webhook/src',
        body: bigBody,
        headers: { 'x-hub-signature-256': signBody(bigBody, 's') },
      });
      status = res.status;
    } catch {
      // req.destroy() on the server side may reset the connection before the
      // 413 response can be flushed to the client.
    }
    // If a response was received it must be 413.
    if (status !== undefined) {
      expect(status).toBe(413);
    }
    // executeCronJob must never be called regardless of response fate.
    await tick();
    expect(vi.mocked(executeCronJob)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — close
// ---------------------------------------------------------------------------

describe('startWebhookServer close', () => {
  it('close() resolves and the server stops accepting connections', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webhook-close-'));
    const configPath = path.join(tmpDir, 'webhooks.json');
    await fs.writeFile(configPath, JSON.stringify({}), 'utf8');

    const handle = await startWebhookServer({
      configPath,
      port: 0,
      host: '127.0.0.1',
      guildId: 'guild-1',
      executorCtx: {} as any,
    });
    const { port } = handle.server.address() as { port: number };

    await handle.close();

    // After close, new connections should be refused.
    await expect(makeRequest(port, { path: '/' })).rejects.toThrow();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
