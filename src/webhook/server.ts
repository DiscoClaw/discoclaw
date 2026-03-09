/**
 * Local webhook ingress surface.
 *
 * - `/webhook/:source` provides HMAC-verified webhook ingress.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import { executeCronJob, type CronExecutorContext } from '../cron/executor.js';
import type { CronJob } from '../cron/types.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { sanitizeExternalContent } from '../sanitize-external.js';

// ---------------------------------------------------------------------------
// Shared constants + config types
// ---------------------------------------------------------------------------

const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export type WebhookSourceConfig = {
  /** HMAC-SHA256 secret used to verify the X-Hub-Signature-256 header. */
  secret: string;
  /** Target Discord channel name or ID. */
  channel: string;
  /**
   * Prompt instruction sent to the runtime. If omitted, a default is built
   * from the source name and the raw request body. When provided, the
   * following placeholders are substituted before the prompt is dispatched:
   * - `{{body}}` — replaced with the raw request body text
   * - `{{source}}` — replaced with the webhook source name
   */
  prompt?: string;
};

export type WebhookConfig = Record<string, WebhookSourceConfig>;

export type WebhookServerOptions = {
  /** Optional absolute path to the webhook JSON config file. */
  configPath?: string;
  /** Port to listen on. Default: 8080. */
  port?: number;
  /** Host to bind to. Default: '127.0.0.1' (loopback only). */
  host?: string;
  /** Guild ID used when constructing synthetic webhook CronJobs. */
  guildId?: string;
  /** Executor context passed directly to executeCronJob for webhooks. */
  executorCtx?: CronExecutorContext;
  log?: LoggerLike;
};

export type WebhookServer = {
  /** The underlying Node.js HTTP server. */
  server: http.Server;
  /** Gracefully close the server. */
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

function verifySignature(body: Buffer, secret: string, signatureHeader: string): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const supplied = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export async function loadWebhookConfig(configPath: string): Promise<WebhookConfig> {
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Webhook config must be a JSON object');
  }
  return parsed as WebhookConfig;
}

let webhookJobCounter = 0;

function buildWebhookJob(source: string, src: WebhookSourceConfig, bodyText: string, guildId: string): CronJob {
  webhookJobCounter += 1;
  const id = `webhook-${source}-${webhookJobCounter}`;
  const sanitizedBody = sanitizeExternalContent(bodyText, `webhook:${source}`);
  const prompt = src.prompt !== undefined
    ? src.prompt.replaceAll('{{body}}', sanitizedBody).replaceAll('{{source}}', source)
    : `A webhook event was received from source "${source}".\n\nPayload:\n${sanitizedBody}`;
  return {
    id,
    cronId: '',
    threadId: '',
    guildId,
    name: `webhook:${source}`,
    def: {
      triggerType: 'webhook',
      timezone: 'UTC',
      channel: src.channel,
      prompt,
    },
    cron: null,
    running: false,
  };
}

function respondWebhook(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: status < 400, message: body }));
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
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
// Public API
// ---------------------------------------------------------------------------

export async function startWebhookServer(opts: WebhookServerOptions = {}): Promise<WebhookServer> {
  const {
    configPath,
    port = 8080,
    host = '127.0.0.1',
    guildId,
    executorCtx,
    log,
  } = opts;

  if (configPath && (!guildId || !executorCtx)) {
    throw new Error('Webhook server requires guildId and executorCtx when configPath is set.');
  }

  let config: WebhookConfig = {};
  if (configPath) {
    config = await loadWebhookConfig(configPath);
    log?.info({ configPath, sources: Object.keys(config) }, 'webhook:config loaded');
  }

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.replace(/[?#].*$/, '') || '/';

    const match = pathname.match(/^\/webhook\/([^/?#]+)$/);
    if (!match) {
      respondWebhook(res, 404, 'Not found');
      return;
    }

    if ((req.method ?? 'GET') !== 'POST') {
      respondWebhook(res, 405, 'Method Not Allowed');
      return;
    }

    let source: string;
    try {
      source = decodeURIComponent(match[1]);
    } catch {
      respondWebhook(res, 400, 'Bad request');
      return;
    }

    const src = config[source];
    if (!src) {
      log?.warn({ source }, 'webhook:unknown source');
      respondWebhook(res, 404, 'Not found');
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Request body too large') {
        log?.warn({ source }, 'webhook:body too large');
        respondWebhook(res, 413, 'Payload Too Large');
        return;
      }
      log?.warn({ source, err }, 'webhook:body read error');
      respondWebhook(res, 400, 'Bad request');
      return;
    }

    const sigHeader = String(req.headers['x-hub-signature-256'] ?? '');
    if (!verifySignature(body, src.secret, sigHeader)) {
      log?.warn({ source }, 'webhook:signature verification failed');
      respondWebhook(res, 401, 'Unauthorized');
      return;
    }

    respondWebhook(res, 202, 'Accepted');

    const bodyText = body.toString('utf8');
    const job = buildWebhookJob(source, src, bodyText, guildId!);

    log?.info({ source, jobId: job.id, channel: src.channel }, 'webhook:dispatching');

    void executeCronJob(job, executorCtx!).catch((err) => {
      log?.error({ source, jobId: job.id, err }, 'webhook:executor error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  log?.info(
    {
      host,
      port: (server.address() as { port: number } | null)?.port ?? port,
      webhookSources: Object.keys(config),
    },
    'webhook:server listening',
  );

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
