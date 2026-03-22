# Runtime and Model Switching Guide

Canonical operator guide for switching an existing DiscoClaw instance between supported runtime adapters and model configurations.

Use this page when you need to answer:
- Which `.env` is authoritative for this instance?
- What does `!models` change live, and what survives restart?
- How do I move between `claude`, `gemini-api`, `gemini-cli`, `codex`, `openai`, and `openrouter`?
- How do `DISCOCLAW_TIER_OPENROUTER_FAST`, `DISCOCLAW_TIER_OPENROUTER_CAPABLE`, and `DISCOCLAW_TIER_OPENROUTER_DEEP` work?
- Why did `!models reset` or a restart not do what I expected?

Linux `systemd --user` is the primary path below. macOS `launchd` differences are called out separately.

## Quick decision table

| Goal | Change it in | Restart required | Persists across restart |
| --- | --- | --- | --- |
| Live-switch the main runtime to another adapter right now | `!models set chat <runtime>` | No | No |
| Change the default adapter for the whole instance | `.env` (`PRIMARY_RUNTIME`) | Yes | Yes |
| Change a role's model override | `!models set <role> <tier-or-model>` | No | Yes |
| Make voice stay on a different adapter | `!models set voice <runtime>` | No | Yes |
| Change OpenRouter tier routing | `.env` `DISCOCLAW_TIER_OPENROUTER_<TIER>` | Yes | Yes |
| Revert roles to this instance's startup defaults | `!models reset` | No | Yes |

Important: `!models reset` means "reset to this instance's startup defaults as resolved at boot from `.env` plus built-in fallbacks". It does not mean "reset to repo defaults".

## Supported adapters

| Adapter name | Startup via `PRIMARY_RUNTIME` | Requirement |
| --- | --- | --- |
| `claude` | yes | Claude CLI available |
| `gemini-api` | yes | `GEMINI_API_KEY`; `gemini` remains a compatibility alias for this API runtime |
| `gemini-cli` | yes | Gemini CLI binary available; limited by the runtime capability gate to `streaming_text` |
| `codex` | yes | Install-mode-specific Codex proof gate, not binary presence alone |
| `openai` | yes | Install-mode-specific OpenAI proof gate, not `OPENAI_API_KEY` presence alone |
| `openrouter` | yes | Shipped env-key path plus live `openrouter-key: ok` proof; not key presence alone |
| `anthropic` | no | Voice-only direct API runtime; not a valid `PRIMARY_RUNTIME` |

For Gemini, keep the runtime paths explicit:
- `gemini-api` is the API-backed Gemini runtime. `PRIMARY_RUNTIME=gemini` and `!models set <chat|voice> gemini` both normalize to `gemini-api` for compatibility.
- `gemini-cli` is the CLI-backed Gemini runtime. It is intentionally narrow: `src/runtime/strategies/gemini-strategy.ts` advertises only `streaming_text`, and DiscoClaw enforces that limit through `resolveEffectiveTools()` in `src/discord/prompt-common.ts` plus `filterToolsByCapabilities()` in `src/runtime/tool-capabilities.ts`, which drop unsupported tools before the turn starts.
- Model-based runtime inference is still provider-level for Gemini. When you need a specific subpath, use an explicit runtime-name switch (`gemini-api` or `gemini-cli`) or set `PRIMARY_RUNTIME` explicitly instead of relying on model ownership inference.
- Treat `GEMINI_API_KEY` and Gemini CLI binary availability as proof for different subpaths, not as a single interchangeable "Gemini is supported" story.

For `codex`, use the proof gate that matches the install mode you are actually operating:
- Source checkout: [docs/audit/codex-blank-machine-readiness.md](audit/codex-blank-machine-readiness.md), including the manual `codex exec ...` session-auth step.
- npm-managed install: [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md). That path is currently not fully support-claimable; the documented shell gate does not by itself prove daemon parity.

For `openai`, prove the active path the same way:
- Source checkout: when any configured route uses OpenAI, use the repo smoke harness described in [docs/audit/codex-blank-machine-readiness.md](audit/codex-blank-machine-readiness.md), for example `OPENAI_SMOKE_TEST_TIERS=fast pnpm test`.
- npm-managed Codex/OpenAI alternate path: follow [docs/audit/codex-npm-managed-path.md](audit/codex-npm-managed-path.md) and confirm live runtime-visible evidence such as `openai-key: ok` after startup. `OPENAI_API_KEY` in `.env` is config only.

For `openrouter`, the current shipped boundary is narrower:
- Set `OPENROUTER_API_KEY` in the authoritative `.env`, but treat that as config presence only.
- For source checkouts, `pnpm preflight*` remains setup/bootstrap evidence only, and repo smoke-path validation is the only shipped workload-proof surface for OpenRouter-backed routes.
- Start or restart DiscoClaw and confirm `!status` or the startup credential report shows `openrouter-key: ok`.
- Treat `!models set chat openrouter`, `PRIMARY_RUNTIME=openrouter`, `.env` key presence, and npm-managed `discoclaw doctor` as routing/config evidence only until that proof appears.

For `openai` and `openrouter`, set `OPENAI_COMPAT_TOOLS_ENABLED=1` if you expect full tool use. In logs, the Claude adapter runtime ID is `claude_code` even though the user-facing adapter name is `claude`.

## Find the authoritative instance first

Do not edit anything until you know which install you are operating on.

### 1. Resolve the unit name

- If `.env` contains `DISCOCLAW_SERVICE_NAME=<name>`, the Linux unit is `<name>.service`.
- Otherwise the default unit is `discoclaw.service`.

Examples below use `discoclaw.service`. Replace it with the real unit name for named multi-instance installs.

### 2. Resolve the service working directory

```bash
systemctl --user show -p WorkingDirectory discoclaw.service
systemctl --user cat discoclaw.service
```

The working directory is the first place to inspect. That is the `.env` that matters on restart.

### 3. Determine install mode

- Source checkout: the working directory is a repo clone and contains `.git`.
- npm-managed install: the working directory contains `.env`, `workspace/`, and `data/`, but no `.git`.

Do not assume the global npm package directory is authoritative. For npm-managed installs, the working directory created during `discoclaw init` is the instance.

### 4. Identify the state files

Authoritative files for runtime/model state:
- `.env` in the service working directory
- `models.json` at `$DISCOCLAW_DATA_DIR/models.json`, or `./data/models.json` if `DISCOCLAW_DATA_DIR` is unset
- `runtime-overrides.json` at `$DISCOCLAW_DATA_DIR/runtime-overrides.json`, or `./data/runtime-overrides.json`

Minimum inspection set:

```bash
grep -nE '^(DISCOCLAW_SERVICE_NAME|DISCOCLAW_DATA_DIR|PRIMARY_RUNTIME|RUNTIME_MODEL|DISCOCLAW_FAST_MODEL|DISCOCLAW_FAST_RUNTIME|DISCOCLAW_SUMMARY_MODEL|DISCOCLAW_CRON_MODEL|DISCOCLAW_CRON_AUTO_TAG_MODEL|DISCOCLAW_CRON_EXEC_MODEL|DISCOCLAW_TASKS_AUTO_TAG_MODEL|DISCOCLAW_VOICE_MODEL|FORGE_DRAFTER_MODEL|FORGE_AUDITOR_MODEL|OPENAI_MODEL|OPENROUTER_MODEL|GEMINI_MODEL|CODEX_MODEL|DISCOCLAW_TIER_[A-Z0-9_]+_(FAST|CAPABLE|DEEP))=' .env
grep -nE '^(OPENAI_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY)=' .env | sed -E 's/=.*/=<set>/'
sed -n '1,200p' "${DISCOCLAW_DATA_DIR:-./data}/models.json"
sed -n '1,200p' "${DISCOCLAW_DATA_DIR:-./data}/runtime-overrides.json"
```

Prefer `!restart logs` for service logs. On Linux, `journalctl --user -u discoclaw.service -n 100 --no-pager` is a shell fallback. On macOS, prefer `!restart logs` over an ad hoc `log show` query.

Do not print the full `.env` into Discord, terminal transcripts, or audit logs unless you already redacted secrets. If `DISCOCLAW_DATA_DIR` is defined only inside `.env`, read it from the filtered output first and substitute the real path manually. A missing `runtime-overrides.json` file is normal.

## The three layers of runtime/model state

| Layer | What it controls | Where it lives | How it changes |
| --- | --- | --- | --- |
| Built-in defaults | Repo-shipped role defaults and tier maps | Code (`src/model-config.ts`, `src/runtime/model-tiers.ts`) | Only when the software version changes |
| Startup defaults for this instance | What DiscoClaw boots with before live overrides | `.env` plus built-in fallbacks | Edit `.env`, then restart |
| Persistent live overrides | Role/model/runtime changes made after startup | `models.json` and `runtime-overrides.json` | `!models ...` and runtime auto-switches |

Keep the files separate:
- `models.json` stores model strings per role.
- `runtime-overrides.json` stores runtime-only overlays such as `voiceRuntime`, `fastRuntime`, and `ttsVoice`.

On first run, `models.json` is scaffolded from the startup defaults that instance booted with.

## What ships by default

Role defaults shipped in code:
- `chat`: `capable`
- `fast`: `fast`
- `plan-run`: `capable`
- `summary`: `fast`
- `forge-drafter`: `capable`
- `forge-auditor`: `deep`
- `cron`: `fast`
- `cron-exec`: `capable`
- `voice`: `capable`

Built-in tier maps shipped in code:

| Runtime | `fast` | `capable` | `deep` |
| --- | --- | --- | --- |
| `claude` (`claude_code`) | `haiku` | `claude-opus-4-6` | `claude-opus-4-6` |
| `gemini-api` | `gemini-2.5-flash` | `gemini-2.5-pro` | `gemini-2.5-pro` |
| `gemini-cli` | `gemini-2.5-flash` | `gemini-2.5-pro` | `gemini-2.5-pro` |
| `openai` | `gpt-5-mini` | `gpt-5.4` | `gpt-5.4-pro` |
| `openrouter` | `openai/gpt-5-mini` | `anthropic/claude-sonnet-4.6` | `anthropic/claude-opus-4.6` |
| `codex` | `gpt-5.1-codex-mini` | `gpt-5.4` | `gpt-5.4` |

`gemini-api` and `gemini-cli` currently resolve through the same shipped Gemini tier defaults; the operator-facing split is about runtime selection and capability guarantees, not different built-in Gemini model tiers.

## OpenRouter tier defaults and overrides

DiscoClaw already ships an OpenRouter tier map. With no env overrides set, OpenRouter resolves:
- `fast` to `openai/gpt-5-mini`
- `capable` to `anthropic/claude-sonnet-4.6`
- `deep` to `anthropic/claude-opus-4.6`

`OPENROUTER_MODEL` separately defaults the OpenRouter adapter itself to `anthropic/claude-sonnet-4.6`, so a role that follows the adapter default starts from the same concrete string as the shipped `capable` tier.

If you set `DISCOCLAW_TIER_OPENROUTER_FAST`, `DISCOCLAW_TIER_OPENROUTER_CAPABLE`, or `DISCOCLAW_TIER_OPENROUTER_DEEP`, that exact string replaces only that tier entry in the effective OpenRouter tier map. Override precedence is simple: tier lookup uses the env override when present and otherwise falls back to the shipped built-in value. `OPENROUTER_MODEL` does not rewrite the tier map; only `DISCOCLAW_TIER_OPENROUTER_<TIER>` does.

Set only the tiers you intentionally want to change. Even a single unique effective tier entry is enough for exact-string reverse-mapping in fast/voice runtime auto-switching.

Exact-match rules:
- `openai/gpt-5-mini` matches `openai/gpt-5-mini`
- `gpt-5-mini` does not match `openai/gpt-5-mini`
- `fast` does not match anything because it is a tier name, not a concrete model string

Even without overrides, `PRIMARY_RUNTIME=openrouter` and the default `OPENROUTER_MODEL` work against the shipped OpenRouter tier map. Keep the support claim narrow: source checkouts still need repo smoke-path validation for the exact OpenRouter-backed workload under test, while npm-managed installs should stop at post-start evidence such as `openrouter-key: ok`.

## Where each kind of change persists

| Change | Persists in | Notes |
| --- | --- | --- |
| Default chat adapter at startup | `.env` `PRIMARY_RUNTIME` | Restart required |
| Adapter default model | `.env` `OPENAI_MODEL`, `OPENROUTER_MODEL`, `GEMINI_MODEL`, `CODEX_MODEL` | `GEMINI_MODEL` applies to both `gemini-api` and `gemini-cli`; used when a role follows the adapter default |
| Tier map for a runtime | `.env` `DISCOCLAW_TIER_<RUNTIME>_<TIER>` | Restart required |
| Per-role model override | `models.json` | Written by `!models set <role> <tier-or-model>` |
| Persistent fast runtime override | `runtime-overrides.json` | Written when fast auto-switches to another runtime |
| Persistent voice runtime override | `runtime-overrides.json` | Written by `!models set voice <runtime>` or by voice auto-switch |
| Temporary main-runtime swap | live memory only | Written by `!models set chat <runtime>`; lost on restart |

Legacy note: `DISCOCLAW_FAST_RUNTIME` is deprecated. Prefer `!models set fast <model>`, which updates `models.json` and can persist `fastRuntime` in `runtime-overrides.json` when the model string uniquely identifies one runtime. Shared IDs such as `gpt-5.4` fail closed and do not auto-switch. Keep `DISCOCLAW_FAST_RUNTIME` only for startup compatibility; `!models reset` does not clear it because reset does not edit `.env`.

## What each `!models` command really does

| Role | `!models set` persistence | Runtime behavior |
| --- | --- | --- |
| `chat` | Tier/model values persist to `models.json` | `!models set chat <runtime>` swaps the main runtime live, resets chat to that adapter default, keeps plan/deferred-run/cron-exec on the main runtime adapter, and does not write the runtime name to disk |
| `fast` | Persists the model value to `models.json` | Concrete model strings can auto-switch the fast runtime and write `fastRuntime` |
| `plan-run` | Persists the model value to `models.json` | Used by `!plan run`, `!plan run-one`, `!plan run-phase`, and `planRun`. It has its own startup default (`DISCOCLAW_PLAN_RUN_MODEL`, default `capable`) and does not inherit the `chat` role's current model string |
| `summary` | Persists to `models.json` | Uses the fast runtime; model strings do not auto-switch runtimes |
| `cron` | Persists to `models.json` | Uses the fast runtime; model strings do not auto-switch runtimes |
| `cron-exec` | Persists to `models.json` unless you use `default` | Follows chat runtime unless overridden by cron-specific config; model strings do not auto-switch runtimes |
| `forge-drafter` | Persists to `models.json` | Follows chat runtime unless env says otherwise; model strings do not auto-switch runtimes |
| `forge-auditor` | Persists to `models.json` | Follows chat runtime unless env says otherwise; model strings do not auto-switch runtimes |
| `voice` | Persists the model to `models.json` | `!models set voice <runtime>` or a concrete cross-provider model can write `voiceRuntime` |

Only `fast` and `voice` auto-switch runtimes from concrete model ownership. For `chat`, only an explicit runtime name such as `openrouter` changes the runtime; plain model strings stay on the current runtime. `plan-run`, `summary`, `cron`, `cron-exec`, `forge-drafter`, and `forge-auditor` also keep their current runtime and can therefore be left pointing at a model string that the active runtime cannot serve.

Important reset semantics:
- `!models reset` writes startup-default model strings back into `models.json`.
- `!models reset` clears `fastRuntime` and `voiceRuntime` overlays from `runtime-overrides.json`.
- `!models reset` does not remove legacy env vars such as `DISCOCLAW_FAST_RUNTIME`.
- `!models reset chat` resets the chat model string, but it does not undo a live chat adapter swap until you restart or switch chat again.

If you ran `!models set chat openrouter`, the active runtime row can stay on OpenRouter even after `!models reset chat`. Restart if you want the startup adapter back immediately.

## Verify switch outcomes and registry failures

`!models` can confirm what is active after a switch attempt. It cannot prove ahead of time that an inactive adapter is registered.

Before switching, verify prerequisites instead:
- The filtered `.env` output shows the expected credential or model keys for the target adapter.
- Recent logs do not already show missing-binary or missing-credential warnings for that adapter.

After switching, run `!models` and inspect:
- the `runtime` row
- any `[runtime: ...]` annotations on `voice`, `summary`, `cron-auto-tag`, or `tasks-auto-tag`
- whether a role now shows a real model, or a literal adapter name where a model should be

If the switch fails or the target never appears active, inspect `!restart logs` first. On Linux, `journalctl --user -u discoclaw.service -n 100 --no-pager` is a useful shell fallback.

Useful warnings:
- `runtime-overrides: voiceRuntime is not a registered runtime; ignoring`
- `runtime-overrides: fastRuntime is not a registered runtime; ignoring`
- `DISCOCLAW_FAST_RUNTIME is not registered; falling back to PRIMARY_RUNTIME`

Do not use `!health` as the only registration check. It does not show the runtime registry state.

## Safe switch recipes

### 1. Persistently switch the whole instance to another adapter

Use this when the default adapter should remain changed after restart.

1. Confirm the authoritative working directory and `.env`.
2. Record the current `!models` output and the `.env` keys you are about to change.
3. Edit `.env` and set `PRIMARY_RUNTIME` to one of `claude`, `gemini-api`, `gemini-cli`, `codex`, `openai`, or `openrouter`. `gemini` still works as a compatibility alias for `gemini-api`, but the explicit names are the canonical operator-facing values.
4. Set or verify the adapter-specific default model env var if you care about adapter-default behavior: `GEMINI_MODEL`, `CODEX_MODEL`, `OPENAI_MODEL`, or `OPENROUTER_MODEL`.
5. If the target is OpenRouter tier switching, inspect or set the specific `DISCOCLAW_TIER_OPENROUTER_<TIER>` vars you want to override from the shipped defaults.
6. Clear role overrides that should stop fighting the new startup defaults, usually with `!models reset chat`, `!models reset fast`, `!models reset plan-run`, `!models reset summary`, `!models reset cron`, `!models reset cron-exec`, `!models reset voice`, `!models reset forge-drafter`, and `!models reset forge-auditor`.
7. Restart the service.
8. Verify with `!models` and logs.

If you changed credentials through Discord DMs, `!secret set KEY=value` updates the authoritative `.env` but does not restart DiscoClaw. You still need a restart.

### 2. Live-switch the main runtime to another adapter without changing startup defaults

Use this for a temporary experiment:

```text
!models set chat codex
!models set chat openrouter
!models set chat gemini-api
!models set chat gemini-cli
```

Expected result in `!models`: the `runtime` row changes to the new adapter, the `chat` row usually becomes that adapter's default model, and plan/deferred-run/cron-exec follow that runtime adapter immediately. Plan execution no longer inherits the `chat` model string, though: it uses the dedicated `plan-run` role and stays on its own startup default or override. Fast and voice can still remain separate if they already have their own runtime overrides. This change is live-only and is lost on restart. To end the experiment, restart or switch chat to another runtime explicitly. Do not assume `!models reset chat` will switch the runtime row back immediately.

When choosing between the two Gemini runtime names:
- Use `gemini-api` for the API-backed path.
- Use `gemini-cli` only when you explicitly want the limited CLI runtime with the tool-capability gate.
- Use `gemini` only when you need compatibility with older operator habits; DiscoClaw resolves it to `gemini-api`.

### 3. Change chat to another model on the current adapter

```text
!models set chat capable
!models set chat gpt-5.4
!models set chat anthropic/claude-sonnet-4.6
```

Tier names resolve against the current chat runtime's tier map. Concrete model strings are stored as-is in `models.json`. They do not auto-switch chat to another provider: `!models set chat gpt-5-mini` keeps the current chat runtime and only changes the stored model string.

### 4. Move fast-tier work onto another provider/model

Preferred path: use `!models set fast <model>`, not `DISCOCLAW_FAST_RUNTIME`.

```text
!models set fast gemini-2.5-flash
!models set fast openai/gpt-5-mini
!models set fast fast
```

Fast runtime auto-switching only happens when the concrete model string exactly matches another runtime's tier map entry and that ownership is unique. That means:
- `!models set fast gemini-2.5-flash` can auto-switch to Gemini
- `!models set fast openai/gpt-5-mini` can auto-switch to OpenRouter because that exact string is already the shipped OpenRouter `fast` tier, or because you overrode `DISCOCLAW_TIER_OPENROUTER_FAST` to that same exact string
- `!models set fast gpt-5.4` does not auto-switch because that model ID is shared by `openai` and `codex`
- `!models set fast fast` changes the model tier but does not identify another provider

If the exact Gemini subpath matters, do not rely on this model-based fast-runtime inference. It selects the Gemini provider family, not an operator-guaranteed `gemini-api` versus `gemini-cli` path.

### 5. Move voice independently

```text
!models set voice gemini-api
!models set voice gemini-cli
!models set voice codex
!models set voice capable
!models set voice google/gemini-2.5-pro
```

Verification pattern in `!models`: the `voice` row shows `[runtime: <adapter>]` when voice differs from chat. Voice runtime changes persist because they write `voiceRuntime` to `runtime-overrides.json`. As with fast runtime, a tier name such as `capable` changes the voice model value but does not, by itself, identify another provider; cross-provider auto-switching needs an exact model string from a tier map.

If you need voice on a specific Gemini subpath, prefer the explicit runtime-name forms above (`!models set voice gemini-api` or `!models set voice gemini-cli`) instead of relying on model-based auto-switching from a Gemini model string.

### 6. Change plan, forge, cron, or summary roles

```text
!models set plan-run capable
!models set forge-drafter capable
!models set forge-auditor deep
!models set cron fast
!models set cron-exec default
!models set summary fast
```

`cron-exec default` is the one special reset-like value for that role. It clears the explicit `cron-exec` override and returns that role to its startup default.

Important: these roles do not auto-switch runtimes from model ownership. If you point `plan-run`, `summary`, `cron`, `cron-exec`, `forge-drafter`, or `forge-auditor` at a cross-provider model string, DiscoClaw still runs that role on its current fast/chat-derived runtime unless you move that runtime separately. That can leave an invalid runtime/model pairing.

## Rollback checklist

Use this if a switch fails, the wrong adapter stays active, or the new runtime cannot start cleanly.

1. Start from the values you recorded before the change: the previous `!models` output plus the exact `.env` keys you edited.
2. If the failed change was live-only, restore the prior live state first: `!models set chat <previous-runtime>` or restart for chat, `!models reset fast` or `!models set fast <previous-model>` for fast, and `!models reset voice` or `!models set voice <previous-runtime-or-model>` for voice.
3. If the failed change was persistent, restore the previous `.env` values for `PRIMARY_RUNTIME`, any adapter default model vars you changed, and any `DISCOCLAW_TIER_*` vars you changed.
4. Clear bad persistent overlays if they are still fighting the restored defaults: run `!models reset` or targeted `!models reset <role>` commands, then inspect `runtime-overrides.json` for stale `fastRuntime` or `voiceRuntime`.
5. Restart the service. On macOS, if you changed `.env`, rerun `discoclaw install-daemon` or reload the launchd plist before restarting.
6. Re-verify with `!models` and `!restart logs` before attempting another switch.

## Verification checklist

After any switch:
1. Run `!models`.
2. Confirm the runtime row and the affected role match the intended outcome.
3. Confirm any separate fast/voice runtime shows as `[runtime: ...]` on the affected rows.
4. If you edited `.env`, restart and run `!models` again.
5. If startup failed or the adapter did not switch, inspect `!restart logs` before changing anything else.

Good signs:
- `runtime` changed after a live chat runtime switch
- `voice` shows `[runtime: gemini-api]`, `[runtime: gemini-cli]`, or similar when intentionally separated
- `summary`, `cron-auto-tag`, or `tasks-auto-tag` show `[runtime: ...]` when fast runtime moved
- the displayed model is a concrete model or a tier resolution like ``capable → anthropic/claude-sonnet-4.6``

Bad signs:
- `runtime` stayed on the old adapter when you expected a chat runtime swap
- a role literally shows ``openrouter`` or ``codex`` as the model string
- startup logs warn that the runtime is unregistered or missing credentials

## Restart and rebuild rules

### No restart, no rebuild

Use `!models set ...` only for live main-runtime experiments via `!models set chat <runtime>`, role model overrides written to `models.json`, and voice runtime changes via `!models set voice <runtime>`.

### Restart required, rebuild not required

Edit `.env`, then restart. Examples: changing `PRIMARY_RUNTIME`, `OPENROUTER_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`, `CODEX_MODEL`, `DISCOCLAW_TIER_OPENROUTER_FAST/CAPABLE/DEEP`, or credentials such as `OPENROUTER_API_KEY`.

### Rebuild first, then restart

Only needed when code changed or the installed package was updated.

```bash
cd ~/code/discoclaw
git pull
pnpm install
pnpm build
```

Restart only after the build succeeds.

## macOS launchd caveat

On macOS, `discoclaw install-daemon` writes a launchd plist with the current `.env` values baked into it. `launchd` does not re-read `.env` on `!restart` or `launchctl kickstart`, so editing `.env` alone is not enough.

After changing credentials, `PRIMARY_RUNTIME`, `OPENROUTER_MODEL`, or any `DISCOCLAW_TIER_*` env var on macOS, either rerun `discoclaw install-daemon` from the authoritative working directory or manually rewrite and reload the plist with `launchctl bootout ...` and `launchctl bootstrap ...`. A plain restart reuses the old env snapshot.

## Troubleshooting

### `!models reset` did not return the model I expected

Check the startup-default env vars first: `RUNTIME_MODEL`, `DISCOCLAW_PLAN_RUN_MODEL`, `DISCOCLAW_FAST_MODEL`, `DISCOCLAW_SUMMARY_MODEL`, `DISCOCLAW_TASKS_AUTO_TAG_MODEL`, `DISCOCLAW_CRON_MODEL`, `DISCOCLAW_CRON_AUTO_TAG_MODEL`, `DISCOCLAW_CRON_EXEC_MODEL`, `DISCOCLAW_VOICE_MODEL`, `FORGE_DRAFTER_MODEL`, `FORGE_AUDITOR_MODEL`, and any `DISCOCLAW_TIER_*` overrides.

`DISCOCLAW_FAST_MODEL` is the legacy startup fallback for the `fast` role. If `DISCOCLAW_SUMMARY_MODEL`, `DISCOCLAW_CRON_MODEL`, `DISCOCLAW_CRON_AUTO_TAG_MODEL`, or `DISCOCLAW_TASKS_AUTO_TAG_MODEL` are unset, they inherit from that same fast-model fallback. Also inspect `DISCOCLAW_FAST_RUNTIME` in `.env` and `voiceRuntime` or `fastRuntime` in `runtime-overrides.json`.

### The adapter did not actually switch

Symptoms:
- `!models set chat openrouter` leaves the `runtime` row unchanged
- `!models` shows a literal runtime name as the model string
- logs contain missing credential or missing binary warnings

Fix the missing prerequisite first, restart, then retry.

### I edited `.env`, restarted, and nothing changed

You almost certainly edited the wrong `.env`. Re-check `systemctl --user show -p WorkingDirectory discoclaw.service`, the path of the `.env` you edited, and `DISCOCLAW_DATA_DIR` from that same working directory.

### Old fast defaults keep returning after restart

You still have a startup or persistent fast-runtime override somewhere. Inspect `.env` for `DISCOCLAW_FAST_RUNTIME`, `models.json`, and `runtime-overrides.json`. Also check whether `DISCOCLAW_FAST_MODEL` is still setting the startup fallback that `fast`, `summary`, `cron`, or task auto-tagging inherit from.

Preferred cleanup path: remove the legacy `DISCOCLAW_FAST_RUNTIME` entry once the replacement `!models set fast <model>` workflow is verified, because the env var survives `!models reset`.

### Voice keeps coming back on the wrong adapter

Inspect `runtime-overrides.json` for `voiceRuntime` and confirm whether `ANTHROPIC_API_KEY` is auto-registering the voice-only `anthropic` runtime.

### An AI agent keeps quoting stale workspace docs

If `workspace/AGENTS.md` or `workspace/TOOLS.md` contains old bootstrap-copied runtime-switching instructions, an agent may follow those instead of this guide.

Fix:
- keep `docs/runtime-switching.md` as the canonical operator runbook
- trim `workspace/AGENTS.md` and `workspace/TOOLS.md` down to local overrides only
- remove stale copied boilerplate, especially old runtime-switching or install instructions

## AI operator handoff prompt

Use this when another AI agent needs to guide a user through a switch:

```text
Help me switch this DiscoClaw instance to a different runtime adapter or model safely.

First determine whether this is a source checkout or an npm-managed install, and identify the service/unit name plus the authoritative `.env`, `models.json`, and `runtime-overrides.json`.

Then:
1. Show the current effective state with `!models`.
2. Inspect the filtered `.env`, `models.json`, and `runtime-overrides.json`, and call out stale fast/voice runtime overrides before changing anything.
3. Verify prerequisites for the target adapter from those filtered config keys and from recent service logs; do not claim an inactive adapter is registered based on `!models` alone.
4. Explain which parts are startup defaults from `.env` plus built-in fallbacks versus persistent overrides.
5. Record the current runtime/model state before making changes so rollback is possible.
6. If the goal is a persistent adapter switch, update `.env` and clear conflicting overrides.
7. If the goal is OpenRouter tier switching, inspect or set the needed `DISCOCLAW_TIER_OPENROUTER_<TIER>` vars, and explain that reverse-mapping is exact-string only.
8. If the goal is a live experiment, use `!models set ...` instead of editing `.env`.
9. After changes, verify with `!models` and `!restart logs`.

Do not assume `!models reset` means repo defaults. Treat it as reset-to-this-instance-startup-defaults, remember that `!models reset chat` does not undo a live chat runtime swap until restart, and remember that only `fast` and `voice` auto-switch runtimes from concrete model strings.
```
