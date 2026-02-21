# Plan: Regex Reliability Migration Tracker (Structural Sites)

**ID:** plan-regex-reliability
**Task:** (system)
**Created:** 2026-02-21
**Status:** DRAFT
**Project:** discoclaw

---

## Objective

Track implementation of reliability upgrades for structural regex sites so control-flow/state parsing no longer depends on fragile free-form text patterns.

## Scope

**In:**
- 12 structural regex sites listed in `docs/regex-reliability-audit.md`
- Strict-compat migrations (dual-path, fallback, parity gates)
- Parser/event/metadata reliability hardening

**Out:**
- Non-structural validation/sanitization regex usages
- Behavior-changing product redesign

## Workstream Status

| Workstream | Status | Owner | Notes |
| --- | --- | --- | --- |
| A. Baseline + Fixtures | DONE | system | Added/expanded tests for parser and migration behavior |
| B. P0 Reliability Replacements | DONE | system | S01, S02, S04, S05, S07 implemented |
| C. P1 Replacements | DONE | system | S03, S06, S08, S09, S10 implemented |
| D. P2 Hardening/Cleanup | DONE | system | S12 implemented, S11 retained by decision |
| E. Cutover + Fallback Retirement | IN PROGRESS | system | Fallbacks retained for compatibility window |

## Site Tracker

| ID | Site | Decision | Priority | Status | Dependency | Exit Gate |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | `plan-manager` changes/file extraction | Replace | P0 | DONE | S02 optional but preferred | Parity on fixture corpus; no critical mismatch |
| S02 | `plan-manager` phases deserialization | Replace | P0 | DONE | None | JSON-first state stable in run flows |
| S03 | `plan-commands` plan parsing | Replace | P1 | DONE | None | Shared parser adopted in plan commands |
| S04 | forge audit verdict parsing | Replace | P0 | DONE | None | JSON verdict parse >= 99% staged runs |
| S05 | forge plan ID extraction from text | Replace | P0 | DONE | None | No text scraping in forge create path |
| S06 | audit-handler structural checks | Replace | P1 | DONE | S03 | Concern output parity with baseline |
| S07 | discord action parser | Harden | P0 | DONE | None | Unified scanner parity with current behavior |
| S08 | durable extraction JSON parse | Replace | P1 | DONE | None | No regressions, low fallback rate |
| S09 | cron ID parse from content | Replace | P1 | DONE | None | Metadata-first linkage in stats path |
| S10 | task short ID from thread name | Replace | P1 | DONE | None | Mapping-first resolution in reconciliation |
| S11 | webhook route regex | Keep | P2 | ACCEPTED | None | Optional URL-parser cleanup only |
| S12 | models command parser | Harden | P2 | DONE | None | Token parser parity with command tests |

## Implementation Phases

### Phase A - Baseline and Safety Harness

Deliverables:

- Add per-site fixture sets for current parser behavior.
- Add dual-path comparator utility for migration rollouts.
- Define fallback telemetry keys for each site.

Acceptance:

- Baseline parser behavior captured and reproducible in tests.

### Phase B - P0 Sites

Target sites:

- S05, S04, S02, S01, S07

Acceptance:

- All P0 sites operating with new primary path and fallback enabled.
- Fallback metrics available for each P0 site.

### Phase C - P1 Sites

Target sites:

- S03, S06, S08, S09, S10

Acceptance:

- Shared plan parser adopted by plan and audit paths.
- Metadata-first linkage in cron/task reconciliation paths.

### Phase D - P2 Sites and Stabilization

Target sites:

- S12, optional S11 cleanup

Acceptance:

- P2 hardening complete and all trackers green.

### Phase E - Fallback Retirement

Deliverables:

- Remove per-site fallback once exit gates hold for sustained window.
- Update docs to declare canonical parser/protocol paths.

Acceptance:

- Legacy regex fallback removed for replace/harden sites where gates passed.

## Global Acceptance Criteria

1. No behavioral regressions in existing plan/forge/action/cron/task command tests.
2. Every replaced site has dual-path migration and explicit fallback.
3. Every cutover has adversarial fixtures, not just happy-path snapshots.
4. Runtime and command paths remain backward compatible during migration window.

## Risks

- Parser mismatch during dual-read period causes divergent behavior.
- Hidden coupling to human-readable markdown/text formats.
- Under-tested malformed input paths (historically regex-tolerant).

## Testing

Required for each site migration:

- Site-level unit tests for new parser/protocol.
- Parity tests against legacy behavior.
- At least one malformed-input/adversarial test.

Required for each merge wave:

- `pnpm build`
- `pnpm test`

---

## Implementation Notes

### Progress Updates

- 2026-02-21: Created tracker and aligned scope/priority with `docs/regex-reliability-audit.md`.
- 2026-02-21: Completed S01/S02/S04/S05/S08 migrations and test coverage.
- 2026-02-21: Completed S03/S06/S07/S09/S10/S12 refactors with fallback-compatible behavior and passing full suite.
