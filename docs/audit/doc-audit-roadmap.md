# DiscoClaw Documentation Remediation Roadmap (2026-02-27)

## Objective

Resolve all high/medium documentation drift found in the audit, then establish automated guardrails to keep docs aligned with implementation.

## Success Criteria

- All `S1` and `S2` findings in `doc-audit-findings.md` are closed.
- `docs/INVENTORY.md` contains no stale file references.
- README includes role-based navigation to key maintainer/operator docs.
- CI enforces at least one docs drift check.

## Wave 1: Correctness Hotfixes (Immediate, 1-2 days)

### WP1 — Restore webhook exposure guidance

- Findings addressed: `DOC-S1-001`, `DOC-S2-002`.
- Deliverables:
  - Add `docs/webhook-exposure.md` with secure exposure patterns and threat notes.
  - Or remove references and replace with in-place guidance in `templates/workspace/TOOLS.md` and `docs/INVENTORY.md`.
- Acceptance:
  - No references to missing `docs/webhook-exposure.md`.
  - Operator path for external webhook setup is complete and testable.

### WP2 — Repair inventory source mappings

- Findings addressed: `DOC-S2-003`, `DOC-S2-004`.
- Deliverables:
  - Fix stale bang-command file paths in `docs/INVENTORY.md`.
  - Resolve contradictory README status.
- Acceptance:
  - `git ls-files` confirms all explicit file paths listed in `docs/INVENTORY.md` exist.
  - No contradictory status lines for the same artifact.

### WP3 — Align `!plan` command examples with runtime output

- Findings addressed: `DOC-S2-005`.
- Deliverables:
  - Update sample output block in `docs/plan-and-forge.md` to match `handlePlanCommand` help text.
  - Ensure `!plan run` semantics are consistently described as all-pending-phase execution.
- Acceptance:
  - Example output and runtime output match for command set and wording intent.

## Wave 2: Navigation and Structure (Short term, 3-5 days)

### WP4 — Add documentation index in README

- Findings addressed: `DOC-S3-007`.
- Deliverables:
  - Add "Documentation Index" section in `README.md`:
    - end user/operator links
    - contributor/maintainer links
    - planning/forge links
- Acceptance:
  - Key docs are reachable from README in <= 1 click.

### WP5 — Define source-of-truth ownership for overlapping topics

- Findings addressed: `DOC-S3-007`, `DOC-S3-008`.
- Deliverables:
  - Add per-doc ownership + source-of-truth notes for overlapping areas:
    - bot setup (`README`, `docs/discord-bot-setup.md`, `.context/bot-setup.md`, skill docs)
    - plan/forge (`docs/plan-and-forge.md`, runtime help output)
    - webhook guidance (`templates/workspace/TOOLS.md`, `docs/INVENTORY.md`, webhook guide)
- Acceptance:
  - Overlapping docs explicitly state canonical owner/source.

### WP6 — Split high-risk monolith docs

- Findings addressed: `DOC-S3-008`.
- Deliverables:
  - Split at least one large file (`docs/plan-and-forge.md` recommended first) into focused subpages.
  - Add index page with stable anchors.
- Acceptance:
  - No single operational doc exceeds agreed threshold (suggested: 600 lines).

## Wave 3: Automation and Governance (Medium term, 1 week)

### WP7 — Add docs drift checks to CI

- Findings addressed: `DOC-S2-006`.
- Deliverables:
  - Add docs job to CI:
    - local link/path target validation
    - stale path references against tracked files
    - optional heading-anchor verification
- Acceptance:
  - PR introducing missing file references fails CI.

### WP8 — Add repeatable audit script

- Findings addressed: `DOC-S2-006` plus future drift.
- Deliverables:
  - Add `scripts/docs-audit.ts` (or equivalent) producing:
    - inventory snapshot
    - stale reference report
    - command/help drift checks for critical command docs
- Acceptance:
  - Script runs locally and in CI with deterministic output.

### WP9 — Establish cadence

- Deliverables:
  - Monthly docs drift check as a standing maintenance task.
  - Required docs review checkbox in release workflow.
- Acceptance:
  - Explicit recurring task exists and is owner-assigned.

## Recommended Ownership

- Wave 1: core maintainer (single-owner for fast closure).
- Wave 2: maintainer + doc co-owner per topic area.
- Wave 3: maintainer + CI owner.

## Exit Gate

Roadmap considered complete when:

- all `S1` and `S2` findings are closed,
- docs CI gate is active on pull requests,
- and the next monthly drift run reports zero missing-file references.
