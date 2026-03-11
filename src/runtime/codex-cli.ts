// Codex runtime adapter.
// Uses the Codex app-server as the primary turn transport when configured,
// and falls back to the CLI adapter only when no app-server URL is present.

import path from 'node:path';
import type { RuntimeAdapter, RuntimeInvokeParams } from './types.js';
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

const NATIVE_APP_SERVER_FALLBACK_NOTICE = 'App-server unavailable, falling back to CLI';

function mergeSystemPrompt(
  systemPrompt: string | undefined,
  appendSystemPrompt: string | undefined,
): string | undefined {
  const parts = [systemPrompt, appendSystemPrompt]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function normalizeInvokeParams(
  params: RuntimeInvokeParams,
  opts: CodexCliRuntimeOpts,
): RuntimeInvokeParams {
  return {
    ...params,
    model: params.model || opts.defaultModel,
    systemPrompt: mergeSystemPrompt(params.systemPrompt, opts.appendSystemPrompt),
    ...(opts.disableSessions ? { sessionKey: undefined } : {}),
  };
}

function isTruthyEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function hasNonDefaultCwd(cwd: string, defaultCwd: string): boolean {
  return path.resolve(cwd) !== defaultCwd;
}

function hasAdditionalReadableRoots(addDirs: string[] | undefined): boolean {
  return (addDirs ?? []).some((dir) => dir.trim().length > 0);
}

export function createCodexCliRuntime(opts: CodexCliRuntimeOpts): RuntimeAdapter {
  const appServerUrl = process.env.CODEX_APP_SERVER_URL?.trim();
  const nativeEnabled = isTruthyEnv(process.env.CODEX_APP_SERVER_NATIVE);
  const defaultCwd = process.cwd();
  const strategy = createCodexStrategy(opts.defaultModel, {
    verbosePreview: opts.verbosePreview,
    itemTypeDebug: opts.itemTypeDebug,
  });

  const baseAdapter = createCliRuntime(strategy, {
    binary: opts.codexBin,
    dangerouslySkipPermissions: opts.dangerouslyBypassApprovalsAndSandbox,
    disableSessions: opts.disableSessions,
    appendSystemPrompt: opts.appendSystemPrompt,
    log: opts.log,
  });

  if (!appServerUrl || !nativeEnabled) return baseAdapter;

  const appServerClient = new CodexAppServerClient({
    baseUrl: appServerUrl,
    dangerouslyBypassApprovalsAndSandbox: opts.dangerouslyBypassApprovalsAndSandbox,
    log: opts.log,
  });

  return {
    ...baseAdapter,
    capabilities: new Set([...baseAdapter.capabilities, 'mid_turn_steering']),
    invoke(params) {
      return (async function* () {
        if (params.images && params.images.length > 0) {
          for await (const event of baseAdapter.invoke(params)) {
            yield event;
          }
          return;
        }

        if (hasNonDefaultCwd(params.cwd, defaultCwd) || hasAdditionalReadableRoots(params.addDirs)) {
          for await (const event of baseAdapter.invoke(params)) {
            yield event;
          }
          return;
        }

        try {
          for await (const event of appServerClient.invokeViaTurn(normalizeInvokeParams(params, opts))) {
            yield event;
          }
        } catch (err) {
          opts.log?.debug?.({ err }, 'codex-app-server: bootstrap failed; falling back to CLI');
          yield {
            type: 'text_delta' as const,
            text: NATIVE_APP_SERVER_FALLBACK_NOTICE,
          };
          for await (const event of baseAdapter.invoke(params)) {
            yield event;
          }
        }
      })();
    },
    steer(sessionKey: string, message: string): Promise<boolean> {
      return appServerClient.steer(sessionKey, message);
    },
    interrupt(sessionKey: string): Promise<boolean> {
      return appServerClient.interrupt(sessionKey);
    },
  };
}
