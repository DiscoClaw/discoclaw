// Codex CLI runtime adapter (registry key: "codex-cli").
// Uses the CLI adapter (`codex exec`) exclusively.

import type { RuntimeAdapter, RuntimeInvokeParams } from './types.js';
import { createCliRuntime, killAllSubprocesses } from './cli-adapter.js';
import { remapCrossRuntimeTierModel, resolveReasoningEffort } from './model-tiers.js';
import { createRuntimeErrorEvent } from './runtime-failure.js';
import { resolveForgeCliRoute } from './cli-strategy.js';
import { createCodexStrategy } from './strategies/codex-strategy.js';
import { createAdvertisedCodexCapabilities } from './tool-capabilities.js';

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
  appendSystemPrompt?: string;
  log?: {
    debug(...args: unknown[]): void;
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
  };
};

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
  const normalizedModel = remappedModel?.model ?? requestedModel;
  const effectiveModel = normalizedModel || opts.defaultModel;
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
    model: normalizedModel,
    ...(effectiveReasoningEffort ? { reasoningEffort: effectiveReasoningEffort } : {}),
    systemPrompt: mergeSystemPrompt(params.systemPrompt, opts.appendSystemPrompt),
    ...(opts.disableSessions ? { sessionKey: undefined } : {}),
  };
}

function buildForgePhaseRouteError(
  params: RuntimeInvokeParams,
  reason: string,
): AsyncIterable<ReturnType<typeof createRuntimeErrorEvent> | { type: 'done' }> {
  return (async function* () {
    params.rawEventTap?.(createRuntimeErrorEvent(reason));
    yield createRuntimeErrorEvent(reason);
    yield { type: 'done' as const };
  })();
}

export function createCodexCliRuntime(opts: CodexCliRuntimeOpts): RuntimeAdapter {
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

  return {
    ...baseAdapter,
    capabilities: advertisedCapabilities,
    groundedCapabilities: baseAdapter.capabilities,
    invoke(params) {
      return (async function* () {
        const normalizedParams = normalizeInvokeParams(params, opts);
        const forgeRoute = normalizedParams.forgePhase
          ? resolveForgeCliRoute(normalizedParams.forgePhase)
          : null;

        if (forgeRoute && forgeRoute.status !== 'allow') {
          yield* buildForgePhaseRouteError(
            normalizedParams,
            forgeRoute.reason ?? `Forge phase ${forgeRoute.requestedPhase} cannot dispatch on the current route.`,
          );
          return;
        }

        for await (const event of baseAdapter.invoke(normalizedParams)) {
          yield event;
        }
      })();
    },
  };
}
