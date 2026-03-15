# DiscoClaw Documentation Audit Findings (2026-02-27)

## Severity Model

- `S0` Critical: unsafe or security-harmful documentation.
- `S1` High: operationally blocking/incorrect guidance.
- `S2` Medium: materially stale or contradictory technical guidance.
- `S3` Low: clarity, structure, and maintainability issues.

## Findings Register

| ID | Severity | Title | Impact |
|---|---|---|---|
| DOC-S1-001 | S1 | Webhook exposure doc referenced but missing | Webhook operators are sent to a file that does not exist. |
| DOC-S2-002 | S2 | Inventory marks non-existent docs as done | `docs/INVENTORY.md` reports inaccurate completion state. |
| DOC-S2-003 | S2 | Inventory bang-command source paths are stale | Contributors are pointed to non-existent implementation files. |
| DOC-S2-004 | S2 | Inventory has contradictory README status | Same file is listed as both completed and not completed. |
| DOC-S2-005 | S2 | `!plan` help example in docs is stale | Users get incorrect command surface and outdated `!plan run` semantics. |
| DOC-S2-006 | S2 | CI has no docs quality gate | Doc drift can merge undetected. |
| DOC-S3-007 | S3 | Primary docs navigation is sparse | Important operational docs are not discoverable from README. |
| DOC-S3-008 | S3 | Very large monolithic docs lack split strategy | High maintenance risk and slower review/audit cycles. |

---

## Detailed Findings

### DOC-S1-001 — Webhook exposure doc referenced but missing

**Evidence**

- `docs/INVENTORY.md:193` references `docs/webhook-exposure.md` as done.
- `docs/INVENTORY.md:236` points readers to `docs/webhook-exposure.md` for setup.
- `templates/workspace/TOOLS.md:224` instructs users to read `docs/webhook-exposure.md`.
- Repository check: `git ls-files docs/webhook-exposure.md` returns no file.

**Impact**

- Operators setting up external webhook ingress have no canonical exposure/security guide.

**Recommended fix**

- Create `docs/webhook-exposure.md` immediately (Wave 1), or remove all references and inline minimum safe guidance where referenced.

---

### DOC-S2-002 — Inventory marks non-existent docs as done

**Evidence**

- `docs/INVENTORY.md:190` references `docs/token-efficiency.md`.
- `docs/INVENTORY.md:192` references `docs/tasks-ground-zero-post-hard-cut-plan.md`.
- `docs/INVENTORY.md:193` references `docs/webhook-exposure.md`.
- Repository check: all three are absent from tracked files.

**Impact**

- `docs/INVENTORY.md` cannot be trusted as a source-of-truth completion map.

**Recommended fix**

- Convert these rows to one of: `removed`, `planned`, or `moved`.
- If content moved, point to current canonical file paths.

---

### DOC-S2-003 — Inventory bang-command source paths are stale

**Evidence**

- `docs/INVENTORY.md:264` references `src/discord/stop-command.ts` (missing).
- `docs/INVENTORY.md:271` references `src/discord/secret-command.ts` (missing).
- Actual command handling:
  - `!stop` handled in `src/discord/message-coordinator.ts:695-706`.
  - `!secret` parsed/handled via `src/discord/secret-commands.ts` and `src/discord/message-coordinator.ts:1308-1323`.

**Impact**

- Debugging and onboarding contributors are routed to dead paths.

**Recommended fix**

- Update rows to actual implementation locations.
- Prefer linking command docs to command parser/handler entrypoints.

---

### DOC-S2-004 — Inventory has contradictory README status

**Evidence**

- `docs/INVENTORY.md:199` says README "needs rewrite for MVP audience".
- `docs/INVENTORY.md:312` says README rewrite is complete.

**Impact**

- Contradictory status degrades planning and release confidence.

**Recommended fix**

- Keep one status source in `docs/INVENTORY.md` and remove contradictory duplicate state.

---

### DOC-S2-005 — `!plan` help example in docs is stale

**Evidence**

- `docs/plan-and-forge.md:83-92` sample `!plan` output omits `run-one` and `audit`.
- `docs/plan-and-forge.md:90` says `!plan run` executes next pending phase.
- Actual help output in `src/discord/plan-commands.ts:394-404` includes `run-one` and `audit`, and describes `run` as "execute all remaining phases".

**Impact**

- Users can misinterpret command behavior and miss available commands.

**Recommended fix**

- Update the sample command output block to match runtime help exactly.
- Add a "generated from runtime output" maintenance note.

---

### DOC-S2-006 — CI has no docs quality gate

**Evidence**

- `.github/workflows/ci.yml:21-23` runs install/build/test only.
- No link check, stale-path check, or docs structural check is present in CI.

**Impact**

- Documentation regressions are not blocked pre-merge.

**Recommended fix**

- Add a docs job (link/path verification + key drift checks) and run it on `push` and `pull_request`.

---

### DOC-S3-007 — Primary docs navigation is sparse

**Evidence**

- `README.md` links a narrow subset of docs (e.g. setup/actions/voice/mcp) but not key maintainer docs like `docs/releasing.md` or `docs/plan-and-forge.md`.
- Current landing-page structure has no explicit "documentation index" section.

**Impact**

- Important operator/maintainer guidance is harder to discover.

**Recommended fix**

- Add a short "Documentation Index" section in `README.md` with role-based links.

---

### DOC-S3-008 — Very large monolithic docs lack split strategy

**Evidence**

- `docs/plan-and-forge.md` (1069 lines)
- `docs/discord-actions.md` (550 lines)
- `templates/workspace/TOOLS.md` (501 lines)

**Impact**

- Slower reviews and higher drift probability in single-file references.

**Recommended fix**

- Split by task-oriented subpages with a stable index page and explicit ownership.

---

## Findings Summary

- `S1`: 1
- `S2`: 5
- `S3`: 2
- `S0`: 0

Top priority for immediate remediation: DOC-S1-001, DOC-S2-002, DOC-S2-003, DOC-S2-005, DOC-S2-006.
