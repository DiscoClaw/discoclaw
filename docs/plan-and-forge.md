# Plan & Forge

Canonical reference for DiscoClaw's `!plan` and `!forge` command systems.

## Contents

- **[Command Reference](plan-command-reference.md)** -- `!plan` and `!forge` command syntax, output examples, and configuration env vars.
- **[Architecture](plan-architecture.md)** -- Forge orchestration loop, phase manager internals, plan and phases file formats.
- **[Workflows](plan-workflows.md)** -- Project context, workspace integration, common workflows, branch conventions, and source file map.

---

## 0. When to Use Forge

Forge runs a multi-round draft → audit → revise loop, so it adds real turnaround time (~1–3 minutes for a simple plan, longer for complex ones). Knowing when it pays off prevents unnecessary friction.

### Use forge when

- **The plan is large or the scope is uncertain.** Forge's drafter reads the codebase and identifies the affected files; its auditor catches gaps before implementation starts. This adversarial review is worth the overhead when you'd otherwise guess at scope.
- **You're working in an unfamiliar area of the codebase.** The drafter agent explores the relevant source before writing the plan — it's effectively a free codebase-read pass embedded in planning.
- **You want adversarial review before touching code.** The auditor is explicitly instructed to be skeptical. Catching a design flaw in the plan is much cheaper than catching it mid-phase.
- **The change has non-trivial risks.** Forge's auditor checks for security, correctness, and architectural issues that are easy to miss under time pressure.

### Skip forge when

- **You're iterating quickly on a known change.** If you already know exactly what needs to change and why, `!plan <desc>` + editing the file by hand is faster.
- **The scope is small and well-understood.** A one-file fix with a clear diff doesn't need a multi-round draft loop.
- **You're in a tight feedback loop.** If you're already mid-implementation and need to record a plan for tracking purposes, `!plan <desc>` and filling in the template manually is the right call.

### Cost of editing a plan mid-run

Once `!plan run` has started, the phase runner records a `planContentHash` — a fingerprint of the plan file at generation time. If you edit the plan file while phases are running or between runs, the hash changes and the runner blocks with:

```
Plan file has changed since phases were generated — the existing phases may not match the current plan intent and cannot run safely.

**Fix:** `!plan phases --regenerate <plan-id>`

This regenerates phases from the current plan content. All phase statuses are reset to `pending` — previously completed phases will be re-executed. Git commits from completed phases are preserved on the branch, but the phase tracker loses their `done` status.
```

This is intentional: stale phases may no longer match the plan's intent. The escape hatch is `--regenerate`:

```
!plan phases --regenerate plan-NNN
!plan run plan-NNN
```

When you need to preserve already-completed work, use the resequencing path:

```
!plan phases --regenerate --keep-done plan-NNN
!plan run-phase plan-NNN <phase-id>
```

`--keep-done` preserves prior `done` phases only when regenerated phases still match semantically and dependency validation remains sound. Done phases are dropped back to `pending` if they changed, were removed, or now depend on missing/non-terminal phases.

Full regeneration remains available and resets all phase statuses to `pending`. In both paths, existing git commits are preserved on the branch; only phase-tracker status is recalculated.

---

## 1. Overview

**`!plan`** manages structured implementation plans — markdown files in `workspace/plans/` that track an idea from draft through approval, phase decomposition, and implementation.

**`!forge`** automates plan creation by orchestrating AI agents in a draft → audit → revise loop, producing a reviewed plan ready for human approval.

Runtime note: forge runtime overrides such as `FORGE_DRAFTER_RUNTIME=codex` or `FORGE_AUDITOR_RUNTIME=codex` choose the Codex adapter for those phases, but forge currently forces Codex phases onto `codex exec` by default instead of the native app-server path. Native Codex can still be used for other eligible turn shapes outside forge, and future targeted forge experiments may re-enable it per phase once a given shape is proven reliable.

Prompt-shaping note: across runtimes, forge is more reliable when open-ended research and final strict-output artifact writing are treated as separate steps. Use bounded discovery inputs where possible, and avoid asking a single turn to both roam the repo and emit the final durable plan unless that adapter has already proven it can do that shape reliably.

**When to use which:**

- `!plan <desc>` — you want to write or fill in the plan yourself
- `!forge <desc>` — you want the system to draft, audit, and refine the plan automatically
- With auto implementation enabled, review-ready plans jump straight into execution; otherwise, use `!plan approve` + `!plan run` to execute.

When `FORGE_AUTO_IMPLEMENT=1` (default) the forge still marches every plan through DRAFT → REVIEW, but any REVIEW that meets the gating criteria (no blocking findings, no `CAP_REACHED`, and the context is clean) immediately transitions to APPROVED and kicks off `!plan run`. Severity warnings continue to surface in the completion message and the audit log, and the channel post notes the auto-approval so the team can trace what happened. If the review isn't pristine — blocking issues, cap errors, stale context, or if you opt out by setting `FORGE_AUTO_IMPLEMENT=0` — the bot falls back to the manual CTA described below.

---

## 4. Plan Lifecycle

```
                  ┌─────────┐
  !plan <desc> ──►│  DRAFT  │◄──── error recovery (forge catch block)
  !forge <desc>   └────┬────┘
                       │
           forge completes / manual edit
                       │
                  ┌────▼────┐
                  │ REVIEW  │◄──── forge completion (normal + cap reached)
                  └────┬────┘
                       │
                !plan approve
                       │
                  ┌────▼─────┐
                  │ APPROVED │──────────────────┐
                  └────┬─────┘                  │
                       │                  all phases complete
                 !plan run (phase execution)    (auto-close)
                       │                        │
              ┌────────▼──────────┐             │
              │  IMPLEMENTING     │  (set by phase runner)
              └────────┬──────────┘             │
                       │                        │
              all phases complete                │
                       │                        │
               ┌───────▼───────┐                │
               │   AUDITING    │  (post-implementation audit phase)
               └───────┬───────┘                │
                       │                        │
                  ┌────▼────┐                   │
                  │  DONE   │                   │
                  └─────────┘                   │
                                                │
                  ┌────────┐                    │
                  │ CLOSED │◄───────────────────┘
                  └────────┘

With `FORGE_AUTO_IMPLEMENT=1`, the review still happens, but any REVIEW that meets the gating criteria (no blocking findings, no `CAP_REACHED`, and a pristine workspace context) now auto-transitions to APPROVED and immediately begins `!plan run`. The completion message still calls out any severity warnings so the channel log records lingering concerns even while implementation runs; if the criteria fail or auto implementation is disabled, the manual CTA described earlier under *Manual implementation (opt-out)* takes over instead.

  At any point (except IMPLEMENTING):
  !plan close ──► CLOSED

  Forge cancellation:
  forge cancel ──► CANCELLED
```

**Status transitions by source:**

| Transition | Trigger | Source file |
|-----------|---------|-------------|
| → DRAFT | Plan creation | `plan-commands.ts` (template fill) |
| → DRAFT | Forge error recovery | `forge-commands.ts` (catch block) |
| → REVIEW | Forge normal completion | `forge-commands.ts` (`!lastVerdict.shouldLoop` exit) |
| → REVIEW | Forge cap reached | `forge-commands.ts` (post-loop block) |
| → APPROVED | `!plan approve` | `plan-commands.ts` |
| → CLOSED | `!plan close` | `plan-commands.ts` |
| → CLOSED | All phases complete (auto-close) | `plan-commands.ts` (`closePlanIfComplete`) |
| → CANCELLED | Forge cancellation (`!forge cancel`, 🛑 reaction, `!stop`) | `forge-commands.ts` (AbortSignal raised, interrupts active invocation) |
