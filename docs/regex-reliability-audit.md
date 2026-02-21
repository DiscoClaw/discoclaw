# Regex Reliability Audit (Structural Control-Flow Sites)

Date: 2026-02-21  
Scope: Structural regex usages that influence state transitions, routing, parsing boundaries, or loop control.  
Compatibility policy: Strict (dual-path parse and fallback until parity is proven).

## Summary

This audit covers 12 structural regex sites. Recommendation outcome:

- Replace: 8
- Harden (keep regex but reduce fragility): 3
- Keep (no change): 1

Priority outcome:

- P0: 5
- P1: 4
- P2: 3

## Decision Model

Each site was scored on:

- Impact (1-5): how bad incorrect parsing is.
- Fragility (1-5): how likely format drift causes mismatch.
- Detectability (1-5): how likely failures are caught quickly (higher means harder to detect).

Priority mapping:

- P0: score >= 12 or state/control-path critical.
- P1: score 9-11.
- P2: score <= 8.

Decision classes:

- Replace: move to typed payload/protocol/parser with bounded grammar.
- Harden: keep regex but constrain inputs, centralize parser, add adversarial tests.
- Keep: adequate reliability for bounded grammar and low impact.

## Replacement Matrix

| ID | Location | Current Regex Role | Decision | Target Mechanism | Priority | Score (I/F/D) |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | `src/discord/plan-manager.ts:119` + `src/discord/plan-manager.ts:291` | Extract file paths and change blocks from free-form markdown | Replace | Deterministic markdown section parser + explicit file list manifest fallback | P0 | 5/5/4 |
| S02 | `src/discord/plan-manager.ts:446` | Deserialize full phases state from markdown sections/fields | Replace | Canonical JSON state file (`*-phases.json`) + markdown as view | P0 | 5/5/5 |
| S03 | `src/discord/plan-commands.ts:82` + `src/discord/plan-commands.ts:429` | Parse plan header/objective/audit verdict from markdown | Replace | Shared plan parser module using bounded heading scanner | P1 | 4/4/4 |
| S04 | `src/discord/forge-commands.ts:92` | Infer audit severity/verdict from free-form text | Replace | Auditor JSON contract with schema validation | P0 | 5/5/4 |
| S05 | `src/discord/forge-commands.ts:548` | Extract plan ID from formatted human response text | Replace | Typed create result from `handlePlanCommand` (no text scraping) | P0 | 4/4/4 |
| S06 | `src/discord/audit-handler.ts:44` | Structural preflight by section/body regex checks | Replace | Reuse shared plan parser + typed structural validator | P1 | 4/4/3 |
| S07 | `src/discord/actions.ts:142` | Parse `<discord-action>` blocks including malformed variants | Harden | Single deterministic scanner as primary path, regex fallback only | P0 | 5/3/3 |
| S08 | `src/discord/user-turn-to-durable.ts:74` | Grab first `[...]` fragment from LLM output | Replace | JSON fence extractor + top-level JSON value parser | P1 | 3/5/4 |
| S09 | `src/cron/run-stats.ts:41` | Parse cron ID marker from message content | Replace | Persist cron ID in metadata store keyed by thread/message | P1 | 4/3/4 |
| S10 | `src/tasks/thread-helpers.ts:25` | Parse short task ID from thread name | Replace | Canonical mapping from thread ID to task ID, name parse as fallback only | P1 | 4/3/3 |
| S11 | `src/webhook/server.ts:188` | Route extraction for `/webhook/:source` | Keep | Use `URL` path segmentation optional cleanup (non-blocking) | P2 | 2/2/2 |
| S12 | `src/discord/models-command.ts:25` | Parse `!models set <role> <model>` | Harden | Tokenized command parser + bounded arity | P2 | 2/3/2 |

## Site Findings

### S01 - Plan Changes/File Extraction
Location: `src/discord/plan-manager.ts:119`, `src/discord/plan-manager.ts:233`, `src/discord/plan-manager.ts:291`

Current behavior:

- Extracts file paths from markdown using multiple regex patterns.
- Builds per-file change spec by line matching and indentation heuristics.
- Phase generation depends directly on these outputs.

Failure modes:

- False positives from prose/backticks.
- Missed files when markdown structure drifts.
- Wrong grouping causes incorrect phase decomposition.

Decision: Replace.

Target:

- Implement `parsePlanChangesSection(content)` with explicit heading scan (`## Changes` boundary) and list-item tokenizer.
- Support machine-readable section `## Change Manifest` (JSON array of file paths) when present.
- Legacy regex path remains fallback during migration.

Strict-compat migration:

1. Add new parser and run both parsers in shadow mode.
2. Log mismatches (`old_files != new_files`) without behavior change.
3. After parity threshold, flip primary to new parser with regex fallback.
4. Remove fallback only after stable period.

Required tests:

- Existing fixtures parity.
- Drift fixtures (nested bullets, bold wrappers, extra headings).
- Adversarial prose with backticks not representing paths.

Exit gate:

- Zero critical mismatches in 200+ plan parses across tests and sample corpus.

### S02 - Phases State Deserialization
Location: `src/discord/plan-manager.ts:446`

Current behavior:

- Parses authoritative phase state from markdown by regexing fields and blocks.

Failure modes:

- Formatting or wrapping changes corrupt parse.
- Silent data loss in optional blocks.
- Control-flow errors (wrong next phase, wrong status transitions).

Decision: Replace.

Target:

- Canonical state file: `workspace/plans/<plan-id>-phases.json`.
- Markdown file remains human-readable projection generated from JSON.
- Runtime reads JSON first; markdown parse only for legacy files.

Strict-compat migration:

1. Introduce JSON writer while keeping markdown writes.
2. On read: prefer JSON, fallback to markdown parse.
3. Backfill JSON for existing plans on first successful read.
4. Keep markdown fallback until all active plans have JSON.

Required tests:

- Round-trip JSON serialize/deserialize.
- Migration tests from legacy markdown-only file.
- Corrupt JSON fallback to markdown, with warning.

Exit gate:

- All plan-run operations in tests and staging complete with JSON-first path.

### S03 - Plan Header/Objective/Audit Parsing
Location: `src/discord/plan-commands.ts:82`, `src/discord/plan-commands.ts:429`

Current behavior:

- Independent regex extracts for plan header and sections in command handlers.

Failure modes:

- Divergence between header parse and audit-handler parse behavior.
- Section boundary ambiguity with nested headings/code blocks.

Decision: Replace.

Target:

- Shared module `src/discord/plan-parser.ts`:
  - `parsePlanHeader`
  - `getSection('Objective' | 'Audit Log' | ...)`
  - `getLatestAuditVerdict`
- One parser used by plan commands and audit handler.

Strict-compat migration:

1. Add parser behind wrapper functions preserving current return types.
2. Move callsites one by one.
3. Keep regex implementation as fallback adapter for one release window.

Required tests:

- Golden header extraction.
- Section extraction with nested headings/code fences.
- Legacy verdict formats and no-verdict cases.

Exit gate:

- Old/new parser parity on existing test corpus.

### S04 - Forge Audit Verdict Inference
Location: `src/discord/forge-commands.ts:92`

Current behavior:

- Infers severity/verdict from free-form text patterns.

Failure modes:

- Contradictory text or format drift can misclassify severity.
- Loop control may continue/stop incorrectly.

Decision: Replace.

Target:

- Auditor output contract:
  - JSON object: `{ "maxSeverity": "...", "shouldLoop": true|false, "summary": "...", "concerns": [...] }`
- Parse via schema validation.
- Regex parser retained as fallback only for legacy outputs.

Strict-compat migration:

1. Prompt auditor for JSON in fenced block.
2. Parse JSON first, regex fallback on parse failure.
3. Track fallback rate; keep fallback until near-zero.

Required tests:

- Valid JSON verdict parsing.
- Malformed JSON fallback behavior.
- Contradictory text ignored when JSON present.

Exit gate:

- >= 99% verdicts parsed via JSON path in staged runs.

### S05 - Forge Plan ID Extraction from Text
Location: `src/discord/forge-commands.ts:548`

Current behavior:

- Extracts `plan-###` from human display string returned by plan creation.

Failure modes:

- Any wording/format change breaks extraction.
- Forge creation fails despite successful plan creation.

Decision: Replace.

Target:

- Introduce typed creator API:
  - `createPlan(...) -> { planId, taskId, filePath, displayMessage }`
- Keep current text-returning `handlePlanCommand` for command path compatibility.

Strict-compat migration:

1. Add typed helper and make forge use it.
2. Keep regex fallback only as emergency safety net.
3. Remove fallback after confidence window.

Required tests:

- Forge creation works independent of display-message format.
- Legacy `handlePlanCommand` output still unchanged for existing callers.

Exit gate:

- Zero regex-based ID extraction in forge path.

### S06 - Structural Audit Preflight
Location: `src/discord/audit-handler.ts:44`

Current behavior:

- Dynamic regex checks section presence/body quality.

Failure modes:

- False positives on placeholder detection.
- Drift from plan-command parser behavior.

Decision: Replace.

Target:

- Use shared parsed plan document from S03.
- Typed structural checks on parsed sections.

Strict-compat migration:

1. Implement validator over parsed plan model.
2. Run old and new checks side-by-side, compare concern outputs.
3. Switch primary after parity review.

Required tests:

- Required sections missing/empty cases.
- Changes section file-path quality checks.
- Closed-plan warning behavior.

Exit gate:

- Concern classification parity on existing fixtures.

### S07 - Discord Action Parsing
Location: `src/discord/actions.ts:142`

Current behavior:

- Regex first-pass plus brace scanner second-pass for malformed action blocks.

Failure modes:

- Double-path parser complexity can diverge.
- Mixed malformed XML-like tags may still bypass clean extraction.

Decision: Harden.

Target:

- Make deterministic scanner primary for both well-formed and malformed blocks.
- Keep regex pass as optional compatibility fallback only.

Strict-compat migration:

1. Add unified scanner parser returning same output shape.
2. Shadow compare against current parser in tests.
3. Keep fallback for malformed edge cases until stable.

Required tests:

- Valid action blocks.
- Broken closing tags.
- Nested braces in JSON strings.
- Unknown action types handling.

Exit gate:

- Unified scanner matches current parser results across fixtures.

### S08 - Durable Memory Extraction JSON
Location: `src/discord/user-turn-to-durable.ts:74`

Current behavior:

- Uses first non-greedy bracket match and `JSON.parse`.

Failure modes:

- Captures wrong bracketed text (example arrays, partial fragments).
- Fails on fenced JSON with preceding content.

Decision: Replace.

Target:

- Implement `extractFirstJsonValue(raw)`:
  - Strip markdown fences if present.
  - Find first top-level JSON array/object by bracket-depth scanner.
  - Parse and validate schema.

Strict-compat migration:

1. Try new extractor first.
2. Fallback to legacy regex extractor on parse failure.
3. Emit metric for fallback usage.

Required tests:

- Fenced JSON arrays.
- Multiple bracketed segments.
- Malformed partial arrays.
- Non-array JSON should return empty per current contract.

Exit gate:

- No regressions in existing durable memory tests; fallback near-zero.

### S09 - Cron ID Extraction from Content
Location: `src/cron/run-stats.ts:41`

Current behavior:

- Parses `[cronId:cron-xxxx]` marker out of message text.

Failure modes:

- Marker edits/removal break linkage.
- Message formatting changes impact stats reconciliation.

Decision: Replace.

Target:

- Persist cron ID in stats mapping at creation/update time using thread ID and status message ID.
- Content marker parsing remains legacy fallback.

Strict-compat migration:

1. Write metadata on create/update.
2. Read metadata first; fallback to marker parse.
3. Backfill metadata where marker exists.

Required tests:

- Metadata-first lookup.
- Marker fallback behavior.
- Backfill path.

Exit gate:

- Marker parse no longer required in steady state.

### S10 - Task Short ID from Thread Name
Location: `src/tasks/thread-helpers.ts:25`

Current behavior:

- Extracts `[NNN]` token from thread name prefixed by status emoji.

Failure modes:

- Rename drift/custom edits break task-thread reconciliation.
- Emoji changes affect parsing.

Decision: Replace.

Target:

- Use canonical `external_ref`/thread ID mapping for task lookup.
- Name parsing only as recovery fallback.

Strict-compat migration:

1. Prefer mapping-based resolution in reconciliation flows.
2. Keep name parser for orphan recovery path only.
3. Add observability for fallback frequency.

Required tests:

- Mapping resolution happy path.
- Name-parse fallback when mapping missing.
- Renamed thread still resolves via mapping.

Exit gate:

- Name-based parsing no longer on primary path.

### S11 - Webhook Route Matching
Location: `src/webhook/server.ts:188`

Current behavior:

- Regex route matching for `/webhook/:source`.

Failure modes:

- Limited; route grammar is simple and bounded.

Decision: Keep (optional cleanup).

Optional improvement:

- Parse with `new URL(req.url, 'http://localhost')`, split pathname segments.

Required tests (if cleanup done):

- Exact route match.
- Query string ignored.
- Non-matching route 404.

Exit gate:

- Not blocking for reliability roadmap.

### S12 - Models Command Parsing
Location: `src/discord/models-command.ts:25`

Current behavior:

- Regex match plus token index for `!models set`.

Failure modes:

- Extra spaces/quotes edge cases.
- Ambiguous token extraction if syntax evolves.

Decision: Harden.

Target:

- Tokenized parser with explicit grammar:
  - command token
  - subcommand token
  - role token
  - model token (rest-of-line preserved if desired)

Strict-compat migration:

1. Introduce tokenizer parser.
2. Keep regex parser as fallback for one cycle.
3. Remove fallback after parity.

Required tests:

- Existing valid commands unchanged.
- Invalid role handling.
- Whitespace variations.

Exit gate:

- Parser behavior parity with current command tests plus new edge fixtures.

## Cross-Cutting Additions (Proposed Interfaces/Types)

These are implementation targets from the audit and are not yet merged:

1. `src/discord/plan-parser.ts`
   - `type ParsedPlanDoc`
   - `parsePlan(content: string): ParsedPlanDoc | ParseError`
   - `getSection(doc, name)`

2. `src/discord/phases-state.ts`
   - `type PlanPhasesStateV1`
   - `readPhasesState(planId): JSON-first with markdown fallback`
   - `writePhasesState(state)`

3. `src/discord/forge-audit-verdict.ts`
   - `type AuditVerdictPayload`
   - `parseAuditVerdictPayload(raw): json-first with regex fallback`

4. `src/discord/plan-create.ts`
   - `createPlan(opts): { planId, taskId, filePath, displayMessage }`

5. `src/discord/json-extract.ts`
   - `extractFirstJsonValue(raw): string | null`

## Rollout Sequence

1. P0 first:
   - S05 -> S04 -> S02 -> S01 -> S07
2. P1 second:
   - S03 + S06 together, then S08, S09, S10
3. P2 last:
   - S12, optional S11 cleanup

Dependency notes:

- S03 should land before S06.
- S02 should land before broad plan-run parser refactors relying on canonical phases state.
- S04 can land independently if fallback remains.

## Global Acceptance Gates

1. No user-visible behavior changes under strict-compat mode.
2. Fallback paths instrumented and monitored.
3. New parser paths have adversarial fixtures, not only happy-path tests.
4. Cutover only after parity criteria met per site.

