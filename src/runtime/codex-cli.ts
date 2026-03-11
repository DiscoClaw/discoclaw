// Codex CLI runtime adapter — thin wrapper around the universal CLI adapter.
// All substantive logic lives in cli-adapter.ts + strategies/codex-strategy.ts.

import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from './types.js';
import type { CliAdapterStrategy, CliInvokeContext, ParsedLineResult } from './cli-strategy.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { createCodexStrategy } from './strategies/codex-strategy.js';

/** SIGKILL all tracked Codex subprocesses (e.g. on SIGTERM). */
export function killActiveCodexSubprocesses(): void {
  killAllSubprocesses();
}

export type CodexCliRuntimeOpts = {
  codexBin: string;
  defaultModel: string;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  disableSessions?: boolean;
  verbosePreview?: boolean;
  itemTypeDebug?: boolean;
  appendSystemPrompt?: string;
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
};

function parseNativeFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function shouldBypassNativeInvoke(params: RuntimeInvokeParams): boolean {
  if (params.images && params.images.length > 0) return true;
  if (params.cwd !== process.cwd()) return true;
  if (params.addDirs && params.addDirs.length > 0) return true;
  return false;
}

function isAppServerConnectionOrInitializeError(err: unknown): boolean {
  const visited = new Set<unknown>();
  let cursor: unknown = err;

  while (cursor !== undefined && cursor !== null && !visited.has(cursor)) {
    visited.add(cursor);
    const message = typeof cursor === 'string'
      ? cursor
      : cursor instanceof Error
        ? cursor.message
        : typeof (cursor as { message?: unknown }).message === 'string'
          ? String((cursor as { message?: unknown }).message)
          : '';
    const normalized = message.trim().toLowerCase();

    if (
      normalized.includes('codex app-server initialize failed')
      || normalized.includes('codex app-server websocket')
      || normalized.includes('codex app-server request timed out (initialize)')
      || normalized.includes('codex app-server send failed (initialize)')
    ) {
      return true;
    }

    cursor = typeof cursor === 'object' && cursor
      ? (cursor as { cause?: unknown }).cause
      : undefined;
  }

  return false;
}

async function* invokeWithAppServerFallback(
  appServerClient: CodexAppServerClient,
  baseAdapter: RuntimeAdapter,
  params: RuntimeInvokeParams,
  disableSessions: boolean,
): AsyncIterable<EngineEvent> {
  const nativeParams = disableSessions
    ? { ...params, sessionKey: undefined }
    : params;

  try {
    for await (const event of appServerClient.invokeViaTurn(nativeParams)) {
      yield event;
    }
    return;
  } catch (err) {
    if (!isAppServerConnectionOrInitializeError(err)) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
      yield { type: 'done' };
      return;
    }
  }

  yield { type: 'text_delta', text: 'App-server unavailable, falling back to CLI' };
  for await (const event of baseAdapter.invoke(params)) {
    yield event;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getStringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function trackCodexLifecycleEvent(
  client: CodexAppServerClient,
  evt: unknown,
  ctx: CliInvokeContext,
): void {
  const sessionKey = ctx.params.sessionKey;
  if (!sessionKey) return;

  const record = asRecord(evt);
  if (!record) return;

  const type = getStringField(record, 'type');
  if (!type) return;

  if (type === 'thread.started') {
    const threadId = getStringField(record, 'thread_id', 'threadId');
    if (threadId) client.noteThreadStarted(sessionKey, threadId);
    return;
  }

  if (type === 'turn.started') {
    const turnId = getStringField(record, 'turn_id', 'turnId', 'id');
    if (!turnId) return;

    const threadId = getStringField(record, 'thread_id', 'threadId')
      ?? ctx.sessionMap?.get(sessionKey)
      ?? client.getSessionState(sessionKey)?.threadId;
    if (threadId) client.noteTurnStarted(sessionKey, threadId, turnId);
    return;
  }

  if (
    type === 'turn.completed'
    || type === 'turn.cancelled'
    || type === 'turn.interrupted'
    || type === 'turn.failed'
  ) {
    client.noteTurnCompleted(sessionKey, getStringField(record, 'turn_id', 'turnId', 'id'));
  }
}

function wrapCodexStrategyWithAppServer(
  strategy: CliAdapterStrategy,
  client: CodexAppServerClient,
): CliAdapterStrategy {
  return {
    ...strategy,
    parseLine(evt: unknown, ctx: CliInvokeContext): ParsedLineResult | null {
      trackCodexLifecycleEvent(client, evt, ctx);
      return strategy.parseLine?.(evt, ctx) ?? null;
    },
  };
}

export function createCodexCliRuntime(opts: CodexCliRuntimeOpts): RuntimeAdapter {
  const appServerUrl = process.env.CODEX_APP_SERVER_URL?.trim();
  const nativeAppServerEnabled = parseNativeFlag(process.env.CODEX_APP_SERVER_NATIVE);
  const appServerClient = appServerUrl
    ? new CodexAppServerClient({
      baseUrl: appServerUrl,
      log: opts.log,
    })
    : null;

  const strategy = createCodexStrategy(opts.defaultModel, {
    verbosePreview: opts.verbosePreview,
    itemTypeDebug: opts.itemTypeDebug,
  });

  const baseAdapter = createCliRuntime(
    appServerClient ? wrapCodexStrategyWithAppServer(strategy, appServerClient) : strategy,
    {
      binary: opts.codexBin,
      dangerouslySkipPermissions: opts.dangerouslyBypassApprovalsAndSandbox,
      disableSessions: opts.disableSessions,
      appendSystemPrompt: opts.appendSystemPrompt,
      log: opts.log,
    },
  );

  if (!appServerClient) return baseAdapter;

  return {
    ...baseAdapter,
    capabilities: new Set([...baseAdapter.capabilities, 'mid_turn_steering']),
    invoke(params) {
      if (!nativeAppServerEnabled || shouldBypassNativeInvoke(params)) {
        return baseAdapter.invoke(params);
      }
      return invokeWithAppServerFallback(appServerClient, baseAdapter, params, Boolean(opts.disableSessions));
    },
    steer(sessionKey: string, message: string): Promise<boolean> {
      return appServerClient.steer(sessionKey, message);
    },
    interrupt(sessionKey: string): Promise<boolean> {
      return appServerClient.interrupt(sessionKey);
    },
  };
}
