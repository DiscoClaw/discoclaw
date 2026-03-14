// Codex runtime adapter.
// Uses the Codex app-server as the primary turn transport when configured,
// and falls back to the CLI adapter when native transport is unavailable.

import path from 'node:path';
import type { RuntimeAdapter, RuntimeCapability, RuntimeInvokeParams } from './types.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { remapCrossRuntimeTierModel, resolveReasoningEffort } from './model-tiers.js';
import { createCodexStrategy } from './strategies/codex-strategy.js';

/** SIGKILL all tracked Codex subprocesses (e.g. on SIGTERM). */
export function killActiveCodexSubprocesses(): void {
  killAllSubprocesses();
}

export type CodexCliRuntimeOpts = {
  codexBin: string;
  defaultModel: string;
  streamStallTimeoutMs?: number;
  progressStallTimeoutMs?: number;
  echoStdio?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  disableSessions?: boolean;
  verbosePreview?: boolean;
  itemTypeDebug?: boolean;
  traceNotifications?: boolean;
  appendSystemPrompt?: string;
  log?: {
    debug(...args: unknown[]): void;
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
  };
};

const NATIVE_APP_SERVER_FALLBACK_NOTICE = 'App-server unavailable, falling back to CLI';
const CONSERVATIVE_CODEX_CAPABILITIES = [
  'streaming_text',
  'sessions',
] satisfies readonly RuntimeCapability[];

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
  const requestedModel = params.model || opts.defaultModel;
  const remappedModel = remapCrossRuntimeTierModel(requestedModel, 'codex');
  const effectiveModel = remappedModel?.model ?? requestedModel;
  const effectiveReasoningEffort = params.reasoningEffort
    ?? (remappedModel ? resolveReasoningEffort(remappedModel.sourceTier, 'codex') : undefined);

  if (remappedModel) {
    opts.log?.warn?.(
      {
        requestedModel,
        effectiveModel,
        sourceRuntimeId: remappedModel.sourceRuntimeId,
        sourceTier: remappedModel.sourceTier,
      },
      'codex:model remapped to codex-compatible tier default',
    );
  }

  return {
    ...params,
    model: effectiveModel,
    ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
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

function createAdvertisedCodexCapabilities(
  baseCapabilities: ReadonlySet<RuntimeCapability>,
  opts?: { includeMidTurnSteering?: boolean },
): ReadonlySet<RuntimeCapability> {
  // Codex session restrictions vary by transport and inherited session state, so
  // only advertise the guarantees that hold across fresh, resumed, and bypassed turns.
  const capabilities = new Set<RuntimeCapability>(
    CONSERVATIVE_CODEX_CAPABILITIES.filter((capability) => baseCapabilities.has(capability)),
  );
  if (opts?.includeMidTurnSteering) {
    capabilities.add('mid_turn_steering');
  }
  return capabilities;
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
    echoStdio: opts.echoStdio,
    dangerouslySkipPermissions: opts.dangerouslyBypassApprovalsAndSandbox,
    disableSessions: opts.disableSessions,
    appendSystemPrompt: opts.appendSystemPrompt,
    log: opts.log,
  });
  const advertisedCapabilities = createAdvertisedCodexCapabilities(baseAdapter.capabilities);

  if (!appServerUrl || !nativeEnabled) {
    return {
      ...baseAdapter,
      capabilities: advertisedCapabilities,
      invoke(params) {
        return baseAdapter.invoke(normalizeInvokeParams(params, opts));
      },
    };
  }

  const appServerClient = new CodexAppServerClient({
    baseUrl: appServerUrl,
    streamStallTimeoutMs: opts.streamStallTimeoutMs,
    progressStallTimeoutMs: opts.progressStallTimeoutMs,
    verbosePreview: opts.verbosePreview,
    itemTypeDebug: opts.itemTypeDebug,
    traceNotifications: opts.traceNotifications,
    dangerouslyBypassApprovalsAndSandbox: opts.dangerouslyBypassApprovalsAndSandbox,
    log: opts.log,
  });

  return {
    ...baseAdapter,
    capabilities: createAdvertisedCodexCapabilities(baseAdapter.capabilities, {
      includeMidTurnSteering: true,
    }),
    invoke(params) {
      return (async function* () {
        const normalizedParams = normalizeInvokeParams(params, opts);

        if (normalizedParams.images && normalizedParams.images.length > 0) {
          for await (const event of baseAdapter.invoke(normalizedParams)) {
            yield event;
          }
          return;
        }

        if (normalizedParams.disableNativeAppServer) {
          for await (const event of baseAdapter.invoke(normalizedParams)) {
            yield event;
          }
          return;
        }

        if (hasNonDefaultCwd(normalizedParams.cwd, defaultCwd)) {
          for await (const event of baseAdapter.invoke(normalizedParams)) {
            yield event;
          }
          return;
        }

        try {
          for await (const event of appServerClient.invokeViaTurn(normalizedParams)) {
            yield event;
          }
        } catch (err) {
          opts.log?.warn?.(
            {
              err,
              appServerUrl,
            },
            'codex-app-server: bootstrap failed; falling back to CLI',
          );
          yield {
            type: 'text_delta' as const,
            text: NATIVE_APP_SERVER_FALLBACK_NOTICE,
          };
          for await (const event of baseAdapter.invoke(normalizedParams)) {
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
