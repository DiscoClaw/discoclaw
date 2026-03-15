#!/usr/bin/env tsx

import {
  GLOBAL_SUPERVISOR_BAIL_PREFIX,
  GLOBAL_SUPERVISOR_ENABLED_ENV,
} from '../src/runtime/global-supervisor.js';
import { wrapRuntimeWithGlobalPolicies } from '../src/index.runtime.js';
import type { EngineEvent, RuntimeAdapter } from '../src/runtime/types.js';

type Scenario = 'success' | 'retry_success' | 'deterministic_bail';

type BenchCase = {
  id: string;
  description: string;
  runtimeFactory: () => RuntimeAdapter;
};

type InvocationCounts = {
  events: number;
  auditEvents: number;
  bailEvents: number;
};

type BenchStats = {
  id: string;
  description: string;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  avgEvents: number;
  avgAuditEvents: number;
  avgBailEvents: number;
};

type CliOptions = {
  iterations: number;
  warmup: number;
  basic: boolean;
  json: boolean;
};

function parseIntFlag(argv: string[], flag: string, fallback: number, min: number): number {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = argv[index + 1];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value after ${flag}`);
  }
  return Math.max(min, Math.floor(parsed));
}

function parseCli(argv: string[]): CliOptions {
  return {
    iterations: parseIntFlag(argv, '--iterations', 1000, 1),
    warmup: parseIntFlag(argv, '--warmup', 100, 0),
    basic: argv.includes('--basic'),
    json: argv.includes('--json'),
  };
}

function createScenarioRuntime(scenario: Scenario): RuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(['streaming_text']),
    async *invoke(params): AsyncIterable<EngineEvent> {
      if (scenario === 'success') {
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
        return;
      }

      if (scenario === 'retry_success') {
        const escalated = (params.systemPrompt ?? '').includes('Global Supervisor escalation');
        if (!escalated) {
          yield { type: 'error', message: 'OpenAI API error: 429 rate limit' };
          yield { type: 'done' };
          return;
        }

        yield { type: 'text_final', text: 'ok-after-retry' };
        yield { type: 'done' };
        return;
      }

      yield { type: 'error', message: 'OpenAI API error: 429 overloaded' };
      yield { type: 'done' };
    },
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.floor((sorted.length - 1) * q);
  return sorted[index] ?? 0;
}

function formatMs(value: number): string {
  return value.toFixed(3);
}

function formatNum(value: number): string {
  return value.toFixed(2);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

async function runInvocation(runtime: RuntimeAdapter, caseId: string, index: number): Promise<InvocationCounts> {
  const counts: InvocationCounts = { events: 0, auditEvents: 0, bailEvents: 0 };

  for await (const evt of runtime.invoke({
    prompt: `measure-global-supervisor-overhead:${caseId}`,
    model: 'bench-model',
    cwd: process.cwd(),
    sessionKey: `${caseId}:${index}`,
  })) {
    counts.events += 1;

    if (evt.type === 'log_line' && evt.line.includes('"source":"global_supervisor"')) {
      counts.auditEvents += 1;
      continue;
    }

    if (evt.type === 'error' && evt.message.startsWith(`${GLOBAL_SUPERVISOR_BAIL_PREFIX} `)) {
      counts.bailEvents += 1;
    }
  }

  return counts;
}

async function runCase(benchCase: BenchCase, iterations: number, warmup: number): Promise<BenchStats> {
  const runtime = benchCase.runtimeFactory();

  for (let i = 0; i < warmup; i++) {
    await runInvocation(runtime, `${benchCase.id}:warmup`, i);
  }

  const samplesMs: number[] = [];
  let totalEvents = 0;
  let totalAuditEvents = 0;
  let totalBailEvents = 0;

  for (let i = 0; i < iterations; i++) {
    const started = process.hrtime.bigint();
    const counts = await runInvocation(runtime, benchCase.id, i);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    samplesMs.push(elapsedMs);
    totalEvents += counts.events;
    totalAuditEvents += counts.auditEvents;
    totalBailEvents += counts.bailEvents;
  }

  samplesMs.sort((a, b) => a - b);
  const totalMs = samplesMs.reduce((sum, v) => sum + v, 0);

  return {
    id: benchCase.id,
    description: benchCase.description,
    avgMs: totalMs / iterations,
    p50Ms: quantile(samplesMs, 0.5),
    p95Ms: quantile(samplesMs, 0.95),
    minMs: samplesMs[0] ?? 0,
    maxMs: samplesMs[samplesMs.length - 1] ?? 0,
    avgEvents: totalEvents / iterations,
    avgAuditEvents: totalAuditEvents / iterations,
    avgBailEvents: totalBailEvents / iterations,
  };
}

function printTable(stats: BenchStats[]): void {
  const baseline = stats.find((s) => s.id === 'direct-success');
  const baselineAvg = baseline?.avgMs ?? 0;

  console.log('\nGlobal supervisor overhead benchmark');
  console.log(`gating env: ${GLOBAL_SUPERVISOR_ENABLED_ENV}`);
  console.log('');
  const header = [
    pad('case', 38),
    pad('avg_ms', 10),
    pad('p50_ms', 10),
    pad('p95_ms', 10),
    pad('events', 10),
    pad('audit', 10),
    pad('bail', 10),
    pad('delta_ms', 10),
    pad('delta_%', 10),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of stats) {
    const deltaMs = row.avgMs - baselineAvg;
    const deltaPct = baselineAvg > 0 ? ((row.avgMs / baselineAvg) - 1) * 100 : 0;
    console.log([
      pad(row.id, 38),
      pad(formatMs(row.avgMs), 10),
      pad(formatMs(row.p50Ms), 10),
      pad(formatMs(row.p95Ms), 10),
      pad(formatNum(row.avgEvents), 10),
      pad(formatNum(row.avgAuditEvents), 10),
      pad(formatNum(row.avgBailEvents), 10),
      pad(formatMs(deltaMs), 10),
      pad(formatNum(deltaPct), 10),
    ].join(' '));
  }

  console.log('');
  for (const row of stats) {
    console.log(
      `${row.id}: min=${formatMs(row.minMs)}ms max=${formatMs(row.maxMs)}ms description="${row.description}"`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));

  const cases: BenchCase[] = [
    {
      id: 'direct-success',
      description: 'Direct runtime (no global wrappers)',
      runtimeFactory: () => createScenarioRuntime('success'),
    },
    {
      id: 'wrapped-env-off-success',
      description: 'Runtime-wide wrapper with supervisor env disabled',
      runtimeFactory: () => wrapRuntimeWithGlobalPolicies({
        runtime: createScenarioRuntime('success'),
        maxConcurrentInvocations: 0,
        env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '0' },
      }),
    },
    {
      id: 'wrapped-env-on-success',
      description: 'Runtime-wide wrapper with supervisor enabled (single-cycle success)',
      runtimeFactory: () => wrapRuntimeWithGlobalPolicies({
        runtime: createScenarioRuntime('success'),
        maxConcurrentInvocations: 0,
        env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
      }),
    },
  ];

  if (!opts.basic) {
    cases.push(
      {
        id: 'wrapped-env-on-retry-success',
        description: 'Supervisor retries once and succeeds after escalation',
        runtimeFactory: () => wrapRuntimeWithGlobalPolicies({
          runtime: createScenarioRuntime('retry_success'),
          maxConcurrentInvocations: 0,
          env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
        }),
      },
      {
        id: 'wrapped-env-on-deterministic-bail',
        description: 'Supervisor blocks deterministic retry and emits structured bail',
        runtimeFactory: () => wrapRuntimeWithGlobalPolicies({
          runtime: createScenarioRuntime('deterministic_bail'),
          maxConcurrentInvocations: 0,
          env: { [GLOBAL_SUPERVISOR_ENABLED_ENV]: '1' },
        }),
      },
    );
  }

  const stats: BenchStats[] = [];
  for (const benchCase of cases) {
    const result = await runCase(benchCase, opts.iterations, opts.warmup);
    stats.push(result);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      envGate: GLOBAL_SUPERVISOR_ENABLED_ENV,
      options: opts,
      stats,
    }, null, 2));
    return;
  }

  printTable(stats);
}

try {
  await main();
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
}
