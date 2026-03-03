# Global Supervisor Overhead Audit (2026-03-03)

## Scope

This audit measures runtime overhead introduced by the runtime-wide global supervisor wrapper, gated by `DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED` (default off).

Measured target behavior:

- Env var off: wrapper behaves as pass-through (no supervisor cycle loop).
- Env var on: invocations run through `plan -> execute -> evaluate -> decide` with retry/escalation/bail logic.

## Methodology

Benchmark harness:

- `scripts/measure-global-supervisor-overhead.ts`
- Timing source: `process.hrtime.bigint()`
- Runtime: synthetic in-memory `RuntimeAdapter` scenarios (no network I/O)
- Warmup: 500 invocations per case
- Samples: 10,000 invocations per case
- Output mode: `--json`

Environment:

- Date: 2026-03-03
- Node: `v22.22.0`
- pnpm: `10.28.2`
- Host: `Linux fedora 6.18.12-200.fc43.x86_64`

Commands run:

```bash
pnpm tsx scripts/measure-global-supervisor-overhead.ts --iterations 10000 --warmup 500 --basic --json
pnpm tsx scripts/measure-global-supervisor-overhead.ts --iterations 10000 --warmup 500 --json
```

## Results

### Basic gating run (`--basic`)

| Case | avg_ms | p50_ms | p95_ms | avg_events | avg_audit | avg_bail |
|---|---:|---:|---:|---:|---:|---:|
| direct-success | 0.000666 | 0.000521 | 0.001222 | 2 | 0 | 0 |
| wrapped-env-off-success | 0.000509 | 0.000450 | 0.000761 | 2 | 0 | 0 |
| wrapped-env-on-success | 0.003338 | 0.002956 | 0.003917 | 6 | 4 | 0 |

### Full supervisor run

Baseline for deltas: `direct-success` (`avg_ms = 0.000712`).

| Case | avg_ms | p50_ms | p95_ms | avg_events | avg_audit | avg_bail | delta_ms vs direct |
|---|---:|---:|---:|---:|---:|---:|---:|
| direct-success | 0.000712 | 0.000481 | 0.001282 | 2 | 0 | 0 | 0.000000 |
| wrapped-env-off-success | 0.000568 | 0.000331 | 0.000982 | 2 | 0 | 0 | -0.000145 |
| wrapped-env-on-success | 0.003424 | 0.002926 | 0.004127 | 6 | 4 | 0 | +0.002712 |
| wrapped-env-on-retry-success | 0.007008 | 0.006522 | 0.008597 | 10 | 8 | 0 | +0.006295 |
| wrapped-env-on-deterministic-bail | 0.009012 | 0.008456 | 0.010359 | 10 | 8 | 1 | +0.008299 |

## Interpretation

- `DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED=0` remains effectively pass-through in this harness (same event counts as direct, zero audit/bail events).
- Enabling the supervisor adds single-digit microsecond overhead per invocation in synthetic no-I/O scenarios.
- Retry/bail paths increase event volume (audit + structured bail) and add a few additional microseconds.
- In real model-backed runs, this overhead is expected to be negligible relative to network/model latency, while adding stronger global safety controls.

## Repro Notes

- The benchmark is intentionally synthetic to isolate framework overhead.
- Because absolute times are sub-millisecond, scheduler jitter can produce small negative deltas in wrapper-off vs direct comparisons.
- For long-term tracking, compare medians (`p50_ms`) and rerun with the same iterations/warmup values.
