# DiscoClaw Documentation Traceability Matrix (2026-02-27)

This matrix maps high-impact documentation claims to current source-of-truth files and verification outcomes.

## Verification Legend

- `Verified`: matches source-of-truth.
- `Partial`: mostly correct with caveats.
- `Drift`: claim is stale or contradicted by source-of-truth.

## Traceability Matrix

| Claim Area | Documentation Claim | Source-of-Truth | Status | Notes |
|---|---|---|---|---|
| Allowlist fail-closed | Empty allowlist responds to nobody (`README.md`) | `src/config.ts`, `src/discord/allowlist.ts` | Verified | Config warnings and allowlist implementation align with docs. |
| CLI setup commands | `discoclaw init` + `discoclaw install-daemon` flow (`README.md`) | `src/cli/index.ts`, `src/cli/init-wizard.ts`, `src/cli/daemon-installer.ts` | Verified | Commands and intent are implemented as documented. |
| Runtime update command | `!update` behavior in inventory | `src/discord/update-command.ts` | Partial | Works as documented overall; behavior differs by npm-managed vs git-managed mode. |
| Voice env variables | Voice env table and provider flags (`docs/voice.md`) | `.env.example.full`, `src/config.ts` | Verified | Referenced voice vars exist and are parsed. |
| Release workflow | Retag/manual publish behavior (`docs/releasing.md`) | `.github/workflows/release.yml`, `.github/workflows/publish.yml` | Verified | Workflow comments and guide are consistent. |
| `!plan run` semantics | `run` executes all pending phases (`docs/plan-and-forge.md`) | `src/discord/plan-commands.ts`, `src/discord/message-coordinator.ts` | Verified | Long-form `run` section matches runtime behavior. |
| `!plan` help output example | Sample output block in `docs/plan-and-forge.md` | `src/discord/plan-commands.ts:394-404` | Drift | Sample omits current commands and old run semantics. |
| Inventory doc existence claims | `docs/INVENTORY.md` lists docs as done | tracked files (`git ls-files`) | Drift | Multiple listed docs are missing from repo. |
| Inventory command source mapping | Bang command implementation paths in `docs/INVENTORY.md` | `src/discord/message-coordinator.ts`, `src/discord/secret-commands.ts` | Drift | Two rows point to missing files. |
| Webhook exposure guidance | References to `docs/webhook-exposure.md` | tracked files (`git ls-files`) | Drift | Referenced guide does not exist. |
| CI documentation guardrails | Docs quality checks in CI | `.github/workflows/ci.yml` | Drift | No docs-specific gate currently runs in CI. |

## Verification Commands Used

```bash
git ls-files '*.md'
git ls-files docs/webhook-exposure.md docs/token-efficiency.md docs/tasks-ground-zero-post-hard-cut-plan.md
git ls-files src/discord/stop-command.ts src/discord/secret-command.ts
rg -n "stop-command|secret-command|token-efficiency|webhook-exposure|tasks-ground-zero-post-hard-cut-plan" docs/INVENTORY.md templates/workspace/TOOLS.md
nl -ba src/discord/plan-commands.ts | sed -n '394,404p'
nl -ba docs/plan-and-forge.md | sed -n '83,92p'
nl -ba .github/workflows/ci.yml | sed -n '21,23p'
```

## Traceability Gaps to Close

- Add explicit source-of-truth tags in large docs where behavior is mirrored from runtime output.
- Add CI checks to prevent stale file-path references in docs.
- Ensure inventory content is generated or validated against tracked filesystem state.
