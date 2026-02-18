/**
 * Webhook server — Phase 1
 *
 * Listens on POST /webhook/:source. Each source maps to an HMAC secret
 * and a target Discord channel. Verified requests are dispatched through
 * the existing cron execution pipeline (executeCronJob), giving webhooks
 * runtime invocation, channel routing, model selection, and logging for free.
 *
 * Config file format (JSON):
 *   {
 *     "<source>": {
 *       "secret": "<hmac-sha256-secret>",
 *       "channel": "<discord-channel-name-or-id>",
 *       "prompt": "<optional instruction override>"
 *     }
 *   }
 *
 * HMAC verification: callers must send an `X-Hub-Signature-256` header
 * with value `sha256=<hex-digest>` computed over the raw request body
 * using the per-source secret (same convention as GitHub webhooks).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { LoggerLike } from '../discord/action-types.js';
import type { CronJob } from '../cron/types.js';
import { executeCronJob, type CronExecutorContext } from '../cron/executor.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type WebhookSourceConfig = {
  /** HMAC-SHA256 secret used to verify the X-Hub-Signature-256 header. */
  secret: string;
  /** Target Discord channel name or ID. */
  channel: string;
  /**
   * Prompt instruction sent to the runtime. If omitted, a default is built
   * from the source name and the raw request body.
   */
  prompt?: string;
};

export type WebhookConfig = Record<string, WebhookSourceConfig>;

export type WebhookServerOptions = {
  /** Absolute path to the JSON config file. */
  configPath: string;
  /** Port to listen on. Default: 8080. */
  port?: number;
  /** Host to bind to. Default: '127.0.0.1' (loopback only). */
  host?: string;
  /** Guild ID used when constructing the synthetic CronJob. */
  guildId: string;
  /** Executor context passed directly to executeCronJob. */
  executorCtx: CronExecutorContext;
  log?: LoggerLike;
};

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of two HMAC digests.
 * Returns true when the signature header matches the expected value.
 */
function verifySignature(body: Buffer, secret: string, signatureHeader: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const supplied = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    // timingSafeEqual throws when buffers differ in length.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

async function loadConfig(configPath: string): Promise<WebhookConfig> {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Webhook config must be a JSON object');
  }
  return parsed as WebhookConfig;
}

// ---------------------------------------------------------------------------
// Synthetic CronJob factory
// ---------------------------------------------------------------------------

let webhookJobCounter = 0;

function buildWebhookJob(source: string, src: WebhookSourceConfig, bodyText: string, guildId: string): CronJob {
  webhookJobCounter += 1;
  const id = `webhook-${source}-${webhookJobCounter}`;
  const prompt = src.prompt ?? `A webhook event was received from source "${source}".\n\nPayload:\n${bodyText}`;
  return {
    id,
    cronId: id,
    threadId: '',
    guildId,
    name: `webhook:${source}`,
    def: {
      schedule: '@once',
      timezone: 'UTC',
      channel: src.channel,
      prompt,
    },
    cron: null,
    running: false,
  };
}

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

function respond(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: status < 400, message: body }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type WebhookServer = {
  /** The underlying Node.js HTTP server. */
  server: http.Server;
  /** Gracefully close the server. */
  close(): Promise<void>;
};

/**
 * Start the webhook HTTP server.
 *
 * Returns a handle with the underlying `http.Server` and a `close()` method.
 */
export async function startWebhookServer(opts: WebhookServerOptions): Promise<WebhookServer> {
  const {
    configPath,
    port = 8080,
    host = '127.0.0.1',
    guildId,
    executorCtx,
    log,
  } = opts;

  // Load config eagerly so startup fails fast on bad JSON.
  let config = await loadConfig(configPath);
  log?.info({ configPath, sources: Object.keys(config) }, 'webhook:config loaded');

  const server = http.createServer(async (req, res) => {
    // Only handle POST /webhook/:source
    const url = req.url ?? '';
    const match = url.match(/^\/webhook\/([^/?#]+)$/);
    if (!match || req.method !== 'POST') {
      respond(res, 404, 'Not found');
      return;
    }

    const source = decodeURIComponent(match[1]);
    const src = config[source];
    if (!src) {
      log?.warn({ source }, 'webhook:unknown source');
      // Return 404 to avoid leaking which sources exist.
      respond(res, 404, 'Not found');
      return;
    }

    // Read body before verifying signature.
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      log?.warn({ source, err }, 'webhook:body read error');
      respond(res, 400, 'Bad request');
      return;
    }

    // Verify HMAC signature.
    const sigHeader = String(req.headers['x-hub-signature-256'] ?? '');
    if (!verifySignature(body, src.secret, sigHeader)) {
      log?.warn({ source }, 'webhook:signature verification failed');
      respond(res, 401, 'Unauthorized');
      return;
    }

    // Signature OK — ack immediately, then dispatch in the background.
    respond(res, 202, 'Accepted');

    const bodyText = body.toString('utf8');
    const job = buildWebhookJob(source, src, bodyText, guildId);

    log?.info({ source, jobId: job.id, channel: src.channel }, 'webhook:dispatching');

    // Fire-and-forget — errors are handled inside executeCronJob.
    void executeCronJob(job, executorCtx).catch((err) => {
      log?.error({ source, jobId: job.id, err }, 'webhook:executor error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  log?.info({ port, host }, 'webhook:server listening');

  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
