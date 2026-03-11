// Codex CLI runtime adapter — thin wrapper around the universal CLI adapter.
// All substantive logic lives in cli-adapter.ts + strategies/codex-strategy.ts.

import type { RuntimeAdapter } from './types.js';
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
      return baseAdapter.invoke(params);
    },
    steer(sessionKey: string, message: string): Promise<boolean> {
      return appServerClient.steer(sessionKey, message);
    },
    interrupt(sessionKey: string): Promise<boolean> {
      return appServerClient.interrupt(sessionKey);
    },
  };
}
