import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from './types.js';

export const GLOBAL_SUPERVISOR_ENABLED_ENV = 'DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED';
export const GLOBAL_SUPERVISOR_BAIL_PREFIX = 'GLOBAL_SUPERVISOR_BAIL';

export type GlobalSupervisorPhase = 'plan' | 'execute' | 'evaluate' | 'decide';
export type GlobalSupervisorDecision = 'complete' | 'retry' | 'bail';

export type GlobalSupervisorFailureKind =
  | 'transient_error'
  | 'hard_error'
  | 'runtime_error'
  | 'aborted'
  | 'missing_done'
  | 'exception'
  | 'event_limit';

export type GlobalSupervisorBailReason =
  | 'non_retryable_failure'
  | 'deterministic_retry_blocked'
  | 'max_cycles_exceeded'
  | 'max_retries_exceeded'
  | 'max_wall_time_exceeded'
  | 'max_events_exceeded';

export type GlobalSupervisorLimits = {
  maxCycles: number;
  maxRetries: number;
  maxEscalationLevel: number;
  maxTotalEvents: number;
  maxWallTimeMs: number;
};

export type GlobalSupervisorBailHandoff = {
  source: 'global_supervisor';
  reason: GlobalSupervisorBailReason;
  cycle: number;
  retriesUsed: number;
  escalationLevel: number;
  failureKind: GlobalSupervisorFailureKind;
  retryable: boolean;
  signature: string;
  lastError: string | null;
  limits: GlobalSupervisorLimits;
};

export type GlobalSupervisorAuditPayload = {
  source: 'global_supervisor';
  phase: GlobalSupervisorPhase;
  cycle: number;
  retriesUsed: number;
  escalationLevel: number;
  decision?: GlobalSupervisorDecision;
  reason?: string;
  failureKind?: GlobalSupervisorFailureKind;
  retryable?: boolean;
  signature?: string;
};

export type GlobalSupervisorOpts = {
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  limits?: Partial<GlobalSupervisorLimits>;
  auditStream?: 'stdout' | 'stderr';
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryBackoffMs?: (retryAttempt: number, failure: { kind: GlobalSupervisorFailureKind; signature: string }) => number;
  escalationNoteBuilder?: (ctx: {
    cycle: number;
    escalationLevel: number;
    failureKind: GlobalSupervisorFailureKind;
    signature: string;
    lastError: string | null;
  }) => string;
};

type CycleEvaluation = {
  ok: boolean;
  failureKind: GlobalSupervisorFailureKind;
  retryable: boolean;
  signature: string;
  lastError: string | null;
};

const DEFAULT_LIMITS: GlobalSupervisorLimits = {
  maxCycles: 3,
  maxRetries: 2,
  maxEscalationLevel: 2,
  maxTotalEvents: 5_000,
  maxWallTimeMs: 0,
};

const TRANSIENT_ERROR_RE = /(timed?\s*out|timeout|rate\s*limit|429|overload|temporar|econnreset|eai_again|503|connection\s+reset|network\s+error|service\s+unavailable)/i;
const HARD_ERROR_RE = /(invalid\s+api\s+key|unauthoriz|forbidden|permission\s+denied|outside\s+allowed\s+roots|malformed\s+json)/i;

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

function normalizeLimits(override?: Partial<GlobalSupervisorLimits>): GlobalSupervisorLimits {
  const maxCycles = Math.max(1, normalizePositiveInt(override?.maxCycles, DEFAULT_LIMITS.maxCycles));
  const maxRetries = normalizePositiveInt(override?.maxRetries, DEFAULT_LIMITS.maxRetries);
  return {
    maxCycles,
    maxRetries: Math.min(maxRetries, Math.max(0, maxCycles - 1)),
    maxEscalationLevel: normalizePositiveInt(override?.maxEscalationLevel, DEFAULT_LIMITS.maxEscalationLevel),
    maxTotalEvents: Math.max(1, normalizePositiveInt(override?.maxTotalEvents, DEFAULT_LIMITS.maxTotalEvents)),
    maxWallTimeMs: normalizePositiveInt(override?.maxWallTimeMs, DEFAULT_LIMITS.maxWallTimeMs),
  };
}

function parseBooleanFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function isGlobalSupervisorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanFlag(env[GLOBAL_SUPERVISOR_ENABLED_ENV]);
}

function createAuditEvent(
  payload: Omit<GlobalSupervisorAuditPayload, 'source'>,
  stream: 'stdout' | 'stderr',
): EngineEvent {
  const body: GlobalSupervisorAuditPayload = {
    source: 'global_supervisor',
    ...payload,
  };
  return {
    type: 'log_line',
    stream,
    line: JSON.stringify(body),
  };
}

function normalizeErrorSignatureText(message: string): string {
  return message
    .toLowerCase()
    .trim()
    .replace(/[0-9]+/g, '#')
    .replace(/[0-9a-f]{8,}/g, '<hex>')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function classifyError(message: string | null): { kind: GlobalSupervisorFailureKind; retryable: boolean } {
  if (!message) {
    return { kind: 'missing_done', retryable: true };
  }

  if (/abort(ed)?/i.test(message)) {
    return { kind: 'aborted', retryable: false };
  }

  if (HARD_ERROR_RE.test(message)) {
    return { kind: 'hard_error', retryable: false };
  }

  if (TRANSIENT_ERROR_RE.test(message)) {
    return { kind: 'transient_error', retryable: true };
  }

  return { kind: 'runtime_error', retryable: true };
}

function evaluateCycle(
  sawDone: boolean,
  lastError: string | null,
  threw: boolean,
  forcedFailureKind?: GlobalSupervisorFailureKind,
): CycleEvaluation {
  if (!forcedFailureKind && sawDone && !lastError && !threw) {
    return {
      ok: true,
      failureKind: 'runtime_error',
      retryable: false,
      signature: 'ok',
      lastError: null,
    };
  }

  if (forcedFailureKind === 'event_limit') {
    return {
      ok: false,
      failureKind: 'event_limit',
      retryable: false,
      signature: 'event_limit',
      lastError,
    };
  }

  if (threw) {
    const msg = lastError ?? 'unknown exception';
    const signature = `exception:${normalizeErrorSignatureText(msg)}`;
    const retryable = !/abort(ed)?/i.test(msg) && !HARD_ERROR_RE.test(msg);
    return {
      ok: false,
      failureKind: 'exception',
      retryable,
      signature,
      lastError: msg,
    };
  }

  const detail = classifyError(lastError);
  return {
    ok: false,
    failureKind: detail.kind,
    retryable: detail.retryable,
    signature: `${detail.kind}:${normalizeErrorSignatureText(lastError ?? 'missing_done')}`,
    lastError,
  };
}

function buildEscalationNote(
  ctx: {
    cycle: number;
    escalationLevel: number;
    failureKind: GlobalSupervisorFailureKind;
    signature: string;
    lastError: string | null;
  },
  builder?: GlobalSupervisorOpts['escalationNoteBuilder'],
): string {
  if (builder) {
    return builder(ctx);
  }
  const err = ctx.lastError ? ` Last error: ${ctx.lastError.slice(0, 200)}.` : '';
  return `[Global Supervisor escalation ${ctx.escalationLevel}] Previous cycle ${ctx.cycle} failed (${ctx.failureKind}, signature: ${ctx.signature}). Choose a different strategy and avoid repeating the same failing action.${err}`;
}

function applyEscalation(
  params: RuntimeInvokeParams,
  escalationLevel: number,
  note: string,
): RuntimeInvokeParams {
  if (escalationLevel <= 0 || note.trim() === '') return params;

  const mergedSystemPrompt = params.systemPrompt
    ? `${params.systemPrompt}\n\n${note}`
    : note;

  return {
    ...params,
    systemPrompt: mergedSystemPrompt,
  };
}

function sleepNoop(_ms: number): Promise<void> {
  return Promise.resolve();
}

export function parseGlobalSupervisorBail(message: string): GlobalSupervisorBailHandoff | null {
  if (!message.startsWith(`${GLOBAL_SUPERVISOR_BAIL_PREFIX} `)) return null;
  const raw = message.slice(GLOBAL_SUPERVISOR_BAIL_PREFIX.length + 1);
  try {
    const parsed = JSON.parse(raw) as GlobalSupervisorBailHandoff;
    if (parsed?.source !== 'global_supervisor') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function withGlobalSupervisor(runtime: RuntimeAdapter, opts: GlobalSupervisorOpts = {}): RuntimeAdapter {
  const enabled = opts.enabled ?? isGlobalSupervisorEnabled(opts.env ?? process.env);
  if (!enabled) return runtime;

  const limits = normalizeLimits(opts.limits);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? sleepNoop;
  const auditStream = opts.auditStream ?? 'stderr';

  return {
    ...runtime,
    async *invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
      const startedAt = now();
      let retriesUsed = 0;
      let escalationLevel = 0;
      let totalEventsSeen = 0;
      const failureSignatures = new Map<string, number>();
      let cycle = 0;
      let currentParams: RuntimeInvokeParams = params;

      while (true) {
        cycle += 1;

        yield createAuditEvent(
          {
            phase: 'plan',
            cycle,
            retriesUsed,
            escalationLevel,
          },
          auditStream,
        );

        if (limits.maxWallTimeMs > 0 && now() - startedAt > limits.maxWallTimeMs) {
          const bail: GlobalSupervisorBailHandoff = {
            source: 'global_supervisor',
            reason: 'max_wall_time_exceeded',
            cycle,
            retriesUsed,
            escalationLevel,
            failureKind: 'runtime_error',
            retryable: false,
            signature: 'max_wall_time_exceeded',
            lastError: null,
            limits,
          };

          yield createAuditEvent(
            {
              phase: 'decide',
              cycle,
              retriesUsed,
              escalationLevel,
              decision: 'bail',
              reason: 'max_wall_time_exceeded',
              failureKind: bail.failureKind,
              retryable: false,
              signature: bail.signature,
            },
            auditStream,
          );
          yield { type: 'error', message: `${GLOBAL_SUPERVISOR_BAIL_PREFIX} ${JSON.stringify(bail)}` };
          yield { type: 'done' };
          return;
        }

        yield createAuditEvent(
          {
            phase: 'execute',
            cycle,
            retriesUsed,
            escalationLevel,
            reason: 'start',
          },
          auditStream,
        );

        const cycleBuffer: EngineEvent[] = [];
        let sawDone = false;
        let lastError: string | null = null;
        let threw = false;
        let forcedFailureKind: GlobalSupervisorFailureKind | undefined;

        try {
          for await (const evt of runtime.invoke(currentParams)) {
            totalEventsSeen += 1;
            if (totalEventsSeen > limits.maxTotalEvents) {
              forcedFailureKind = 'event_limit';
              break;
            }

            if (evt.type === 'done') {
              sawDone = true;
              continue;
            }

            if (evt.type === 'error') {
              lastError = evt.message;
            }

            cycleBuffer.push(evt);
          }
        } catch (err) {
          threw = true;
          lastError = String(err);
        }

        const evaluated = evaluateCycle(sawDone, lastError, threw, forcedFailureKind);

        yield createAuditEvent(
          {
            phase: 'evaluate',
            cycle,
            retriesUsed,
            escalationLevel,
            failureKind: evaluated.failureKind,
            retryable: evaluated.retryable,
            signature: evaluated.signature,
          },
          auditStream,
        );

        if (evaluated.ok) {
          yield createAuditEvent(
            {
              phase: 'decide',
              cycle,
              retriesUsed,
              escalationLevel,
              decision: 'complete',
              failureKind: evaluated.failureKind,
              retryable: evaluated.retryable,
              signature: evaluated.signature,
            },
            auditStream,
          );

          for (const evt of cycleBuffer) {
            yield evt;
          }
          yield { type: 'done' };
          return;
        }

        let bailReason: GlobalSupervisorBailReason | null = null;

        if (forcedFailureKind === 'event_limit') {
          bailReason = 'max_events_exceeded';
        } else if (limits.maxWallTimeMs > 0 && now() - startedAt > limits.maxWallTimeMs) {
          bailReason = 'max_wall_time_exceeded';
        } else if (!evaluated.retryable) {
          bailReason = 'non_retryable_failure';
        } else if (cycle >= limits.maxCycles) {
          bailReason = 'max_cycles_exceeded';
        } else if (retriesUsed >= limits.maxRetries) {
          bailReason = 'max_retries_exceeded';
        } else {
          const previousCount = failureSignatures.get(evaluated.signature) ?? 0;
          if (previousCount > 0) {
            bailReason = 'deterministic_retry_blocked';
          }
        }

        if (bailReason) {
          const bail: GlobalSupervisorBailHandoff = {
            source: 'global_supervisor',
            reason: bailReason,
            cycle,
            retriesUsed,
            escalationLevel,
            failureKind: evaluated.failureKind,
            retryable: evaluated.retryable,
            signature: evaluated.signature,
            lastError: evaluated.lastError,
            limits,
          };

          yield createAuditEvent(
            {
              phase: 'decide',
              cycle,
              retriesUsed,
              escalationLevel,
              decision: 'bail',
              reason: bailReason,
              failureKind: evaluated.failureKind,
              retryable: evaluated.retryable,
              signature: evaluated.signature,
            },
            auditStream,
          );

          yield { type: 'error', message: `${GLOBAL_SUPERVISOR_BAIL_PREFIX} ${JSON.stringify(bail)}` };
          yield { type: 'done' };
          return;
        }

        yield createAuditEvent(
          {
            phase: 'decide',
            cycle,
            retriesUsed,
            escalationLevel,
            decision: 'retry',
            failureKind: evaluated.failureKind,
            retryable: evaluated.retryable,
            signature: evaluated.signature,
          },
          auditStream,
        );

        failureSignatures.set(evaluated.signature, (failureSignatures.get(evaluated.signature) ?? 0) + 1);
        retriesUsed += 1;
        escalationLevel = Math.min(limits.maxEscalationLevel, escalationLevel + 1);

        const note = buildEscalationNote(
          {
            cycle,
            escalationLevel,
            failureKind: evaluated.failureKind,
            signature: evaluated.signature,
            lastError: evaluated.lastError,
          },
          opts.escalationNoteBuilder,
        );
        currentParams = applyEscalation(currentParams, escalationLevel, note);

        const backoffRaw = opts.retryBackoffMs?.(retriesUsed, {
          kind: evaluated.failureKind,
          signature: evaluated.signature,
        }) ?? 0;
        const backoffMs = Number.isFinite(backoffRaw) ? Math.max(0, Math.floor(backoffRaw)) : 0;
        if (backoffMs > 0) {
          await sleep(backoffMs);
        }
      }
    },
  };
}
