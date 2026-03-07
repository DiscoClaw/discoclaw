# Runtime and Model Switching Guide

Canonical operator guide for switching an existing DiscoClaw instance between supported runtime adapters and model configurations.

Use this page when you need to answer any of these safely:

- Which `.env` is authoritative for this instance?
- What does `!models` change live, and what survives restart?
- How do I move between `claude`, `gemini`, `codex`, `openai`, and `openrouter`?
- How do `DISCOCLAW_TIER_OPENROUTER_FAST`, `DISCOCLAW_TIER_OPENROUTER_CAPABLE`, and `DISCOCLAW_TIER_OPENROUTER_DEEP` actually work?
- Why did `!models reset` or a restart not do what I expected?

Linux `systemd --user` is the primary path described below. macOS launchd differences are called out separately.

## Quick decision table

| Goal | Change it in | Restart required | Persists across restart |
| --- | --- | --- | --- |
| Test another chat adapter right now | `!models set chat <runtime>` | No | No |
| Change the default adapter for the whole instance | `.env` (`PRIMARY_RUNTIME`) | Yes | Yes |
| Change a role's model override | `!models set <role> <tier-or-model>` | No | Yes |
| Make voice stay on a different adapter | `!models set voice <runtime>` | No | Yes |
| Make fast-tier work route through OpenRouter | `.env` `DISCOCLAW_TIER_OPENROUTER_FAST/CAPABLE/DEEP`, then use an exact OpenRouter tier-mapped model string for auto-switching | Yes for the env change | Yes |
| Revert roles to this instance's startup defaults | `!models reset` | No | Yes |

Important: `!models reset` means "reset to this instance's startup defaults as resolved at boot from `.env` plus built-in fallbacks". It does not mean "reset to repo defaults".

## Supported adapters

User-facing adapter names:

| Adapter name | Startup via `PRIMARY_RUNTIME` | Requirement |
| --- | --- | --- |
| `claude` | yes | Claude CLI available |
| `gemini` | yes | Gemini CLI or `GEMINI_API_KEY`, depending on your install path |
| `codex` | yes | Codex CLI available |
| `openai` | yes | `OPENAI_API_KEY` |
| `openrouter` | yes | `OPENROUTER_API_KEY` |
| `anthropic` | no | Voice-only direct API runtime; not a valid `PRIMARY_RUNTIME` |

For `openai` and `openrouter`, set `OPENAI_COMPAT_TOOLS_ENABLED=1` if you expect full tool use.

Internal note for operators reading logs: the Claude adapter's runtime ID is `claude_code`, but the user-facing adapter name is `claude`.

## Find the authoritative instance first

Do not edit anything until you know which install you are operating on.

### 1. Resolve the unit name

- If `.env` contains `DISCOCLAW_SERVICE_NAME=<name>`, the Linux unit is `<name>.service`.
- Otherwise the default unit is `discoclaw.service`.

Examples below use `discoclaw.service`. Replace it with the real unit name if this is a named multi-instance install.

### 2. Resolve the service working directory

```bash
systemctl --user show -p WorkingDirectory discoclaw.service
systemctl --user cat discoclaw.service
```

The working directory is the first place to inspect. That is the directory whose `.env` matters on restart.

### 3. Determine install mode

Treat the instance as:

- source checkout: the working directory is a repo clone and contains `.git`
- npm-managed install: the working directory contains `.env`, `workspace/`, and `data/`, but no `.git`

Do not assume the global npm package directory is where you should edit config. For npm-managed installs, the instance working directory created during `discoclaw init` is the authoritative location.

### 4. Identify the data files

Authoritative files for runtime/model state:

- `.env` in the service working directory
- `models.json` at `$DISCOCLAW_DATA_DIR/models.json`, or `./data/models.json` if `DISCOCLAW_DATA_DIR` is unset
- `runtime-overrides.json` at `$DISCOCLAW_DATA_DIR/runtime-overrides.json`, or `./data/runtime-overrides.json`

Minimum inspection set:

```bash
sed -n '1,200p' .env
sed -n '1,200p' "${DISCOCLAW_DATA_DIR:-./data}/models.json"
sed -n '1,200p' "${DISCOCLAW_DATA_DIR:-./data}/runtime-overrides.json"
journalctl --user -u discoclaw.service -n 100 --no-pager
```

If `DISCOCLAW_DATA_DIR` is defined only inside `.env`, read it from `.env` first and substitute the real path manually. A missing `runtime-overrides.json` file is normal.

## The three layers of runtime/model state

Three layers interact during switching:

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
| `gemini` | `gemini-2.5-flash` | `gemini-2.5-pro` | `gemini-2.5-pro` |
| `openai` | `gpt-5-mini` | `gpt-5.4` | `gpt-5.4-pro` |
| `codex` | `gpt-5.1-codex-mini` | `gpt-5.4` | `gpt-5.4` |

`openrouter` does not ship with a built-in tier map. If you want `fast`, `capable`, or `deep` to resolve to OpenRouter-backed models, you must define the OpenRouter tier env vars yourself.

## OpenRouter tier overrides

This is the key OpenRouter-specific workflow:

```bash
DISCOCLAW_TIER_OPENROUTER_FAST=openai/gpt-5-mini
DISCOCLAW_TIER_OPENROUTER_CAPABLE=anthropic/claude-sonnet-4
DISCOCLAW_TIER_OPENROUTER_DEEP=google/gemini-2.5-pro
```

### What these env vars do

At startup, DiscoClaw reads any env vars matching:

- `DISCOCLAW_TIER_<RUNTIME>_FAST`
- `DISCOCLAW_TIER_<RUNTIME>_CAPABLE`
- `DISCOCLAW_TIER_<RUNTIME>_DEEP`

For `OPENROUTER`, those three vars create a tier map entry that does not otherwise exist.

That unlocks two separate behaviors:

1. Tier resolution while already on the OpenRouter adapter.
   - Example: if chat runtime is `openrouter`, `!models set chat capable` resolves to whatever `DISCOCLAW_TIER_OPENROUTER_CAPABLE` is set to.
2. Reverse-mapping for fast/voice auto-switching.
   - Example: if `DISCOCLAW_TIER_OPENROUTER_FAST=openai/gpt-5-mini`, then `!models set fast openai/gpt-5-mini` can auto-switch the fast runtime to `openrouter`.

### Exact-match rule

Reverse-mapping is exact-string only.

That means:

- `openai/gpt-5-mini` matches `openai/gpt-5-mini`
- `gpt-5-mini` does not match `openai/gpt-5-mini`
- `fast` does not match anything because it is a tier name, not a concrete model string

For OpenRouter auto-switching, use the exact same provider/model string in both places:

- in `.env` for `DISCOCLAW_TIER_OPENROUTER_FAST/CAPABLE/DEEP`
- in `!models set fast <model>` or `!models set voice <model>`

### Safe OpenRouter rule

If you want predictable OpenRouter tier behavior, set all three:

- `DISCOCLAW_TIER_OPENROUTER_FAST`
- `DISCOCLAW_TIER_OPENROUTER_CAPABLE`
- `DISCOCLAW_TIER_OPENROUTER_DEEP`

Then restart before using tier names like `fast`, `capable`, or `deep` against OpenRouter.

Without those vars:

- `PRIMARY_RUNTIME=openrouter` still works
- `OPENROUTER_MODEL` still provides the adapter default model
- but OpenRouter does not participate in tier-based auto-switching

## Where each kind of change persists

| Change | Persists in | Notes |
| --- | --- | --- |
| Default chat adapter at startup | `.env` `PRIMARY_RUNTIME` | Restart required |
| Adapter default model | `.env` `OPENAI_MODEL`, `OPENROUTER_MODEL`, `GEMINI_MODEL`, `CODEX_MODEL` | Used when a role follows the adapter default |
| Tier map for a runtime | `.env` `DISCOCLAW_TIER_<RUNTIME>_<TIER>` | Restart required |
| Per-role model override | `models.json` | Written by `!models set <role> <tier-or-model>` |
| Persistent fast runtime override | `runtime-overrides.json` | Written when fast auto-switches to another runtime |
| Persistent voice runtime override | `runtime-overrides.json` | Written by `!models set voice <runtime>` or by voice auto-switch |
| Temporary chat runtime experiment | live memory only | Written by `!models set chat <runtime>`; lost on restart |

## What each `!models` command really does

Role behavior is not uniform.

| Role | `!models set` persistence | Runtime behavior |
| --- | --- | --- |
| `chat` | Tier/model values persist to `models.json` | `!models set chat <runtime>` swaps adapters live only and does not write the runtime name to disk |
| `fast` | Persists the model value to `models.json` | Concrete model strings can auto-switch the fast runtime and write `fastRuntime` |
| `summary` | Persists to `models.json` | Uses the fast runtime |
| `cron` | Persists to `models.json` | Uses the fast runtime |
| `cron-exec` | Persists to `models.json` unless you use `default` | Follows chat runtime unless overridden by cron-specific config |
| `forge-drafter` | Persists to `models.json` | Follows chat runtime unless env says otherwise |
| `forge-auditor` | Persists to `models.json` | Follows chat runtime unless env says otherwise |
| `voice` | Persists the model to `models.json` | `!models set voice <runtime>` or a concrete cross-provider model can write `voiceRuntime` |

Important reset semantics:

- `!models reset` writes startup-default model strings back into `models.json`
- `!models reset` clears `fastRuntime` and `voiceRuntime` overlays from `runtime-overrides.json`
- `!models reset` does not remove legacy env vars such as `DISCOCLAW_FAST_RUNTIME`
- `!models reset chat` resets the chat model string, but it does not undo a live chat adapter swap until you restart or switch chat again

That last point matters: if you ran `!models set chat openrouter`, the active runtime row can stay on OpenRouter even after `!models reset chat`. Restart if you want the startup adapter back immediately.

## Verify the target adapter is actually registered

Do not trust a runtime name until the adapter is confirmed present.

### First check `!models`

Run `!models` and inspect:

- the `runtime` row
- any `[runtime: ...]` annotations on `voice`, `summary`, `cron-auto-tag`, or `tasks-auto-tag`
- whether a role now shows a real model, or a literal adapter name where a model should be

### Then check startup logs

If the adapter is not obviously active anywhere, inspect logs:

```bash
journalctl --user -u discoclaw.service -n 100 --no-pager
```

Useful warnings:

- `runtime-overrides: voiceRuntime is not a registered runtime; ignoring`
- `runtime-overrides: fastRuntime is not a registered runtime; ignoring`
- `DISCOCLAW_FAST_RUNTIME is not registered; falling back to PRIMARY_RUNTIME`

Do not use `!health` as the only registration check. It does not show the runtime registry state.

## Safe switch recipes

### 1. Persistently switch the whole instance to another adapter

Use this when the default adapter should remain changed after restart.

1. Confirm the authoritative working directory and `.env`.
2. Edit `.env`.
3. Set `PRIMARY_RUNTIME` to one of `claude`, `gemini`, `codex`, `openai`, `openrouter`.
4. Set or verify the adapter-specific default model env var if you care about adapter-default behavior:
   - `GEMINI_MODEL`
   - `CODEX_MODEL`
   - `OPENAI_MODEL`
   - `OPENROUTER_MODEL`
5. If the target is OpenRouter tier switching, also set:
   - `DISCOCLAW_TIER_OPENROUTER_FAST`
   - `DISCOCLAW_TIER_OPENROUTER_CAPABLE`
   - `DISCOCLAW_TIER_OPENROUTER_DEEP`
6. Clear role overrides that should stop fighting the new startup defaults:
   - `!models reset chat`
   - `!models reset fast`
   - `!models reset summary`
   - `!models reset cron`
   - `!models reset cron-exec`
   - `!models reset voice`
   - `!models reset forge-drafter`
   - `!models reset forge-auditor`
7. Restart the service.
8. Verify with `!models` and logs.

If you changed credentials through Discord DMs, `!secret set KEY=value` updates the authoritative `.env` but does not restart DiscoClaw. You still need a restart.

### 2. Live-switch chat to another adapter without changing startup defaults

Use this for a temporary experiment:

```text
!models set chat codex
!models set chat openrouter
!models set chat gemini
```

Expected result in `!models`:

- the `runtime` row changes to the new adapter
- the `chat` row usually becomes that adapter's default model

This change is live-only. It is lost on restart.

To end the experiment safely:

- restart the service, or
- switch chat to another runtime explicitly

Do not assume `!models reset chat` will switch the runtime row back immediately.

### 3. Change chat to another model on the current adapter

Examples:

```text
!models set chat capable
!models set chat gpt-5.4
!models set chat anthropic/claude-sonnet-4
```

- Tier names resolve against the current chat runtime's tier map.
- Concrete model strings are stored as-is in `models.json`.

### 4. Move fast-tier work onto another provider/model

Examples:

```text
!models set fast gemini-2.5-flash
!models set fast openai/gpt-5-mini
!models set fast fast
```

Fast runtime auto-switching only happens when you set a concrete model string that exactly matches another runtime's tier map entry.

That means:

- `!models set fast gemini-2.5-flash` can auto-switch to Gemini
- `!models set fast openai/gpt-5-mini` can auto-switch to OpenRouter only if `DISCOCLAW_TIER_OPENROUTER_FAST=openai/gpt-5-mini`
- `!models set fast fast` changes the model tier but does not itself identify another provider

### 5. Move voice independently

Examples:

```text
!models set voice gemini
!models set voice codex
!models set voice capable
!models set voice google/gemini-2.5-pro
```

Verification pattern in `!models`:

- the `voice` row shows `[runtime: <adapter>]` when voice differs from chat

Voice runtime changes persist because they write `voiceRuntime` to `runtime-overrides.json`.

As with fast runtime, a tier name such as `capable` changes the voice model value but does not, by itself, identify another provider. Cross-provider auto-switching needs an exact model string from a tier map.

### 6. Change forge, cron, or summary roles

Examples:

```text
!models set forge-drafter capable
!models set forge-auditor deep
!models set cron fast
!models set cron-exec default
!models set summary fast
```

`cron-exec default` is the one special reset-like value for that role. It clears the explicit `cron-exec` override and returns that role to its startup default.

## Verification checklist

After any switch:

1. Run `!models`.
2. Confirm the runtime row and the affected role match the intended outcome.
3. Confirm any separate fast/voice runtime shows as `[runtime: ...]` on the affected rows.
4. If you edited `.env`, restart and run `!models` again.
5. If startup failed or the adapter did not switch, inspect service logs before changing anything else.

Good signs:

- `runtime` changed after a live chat runtime switch
- `voice` shows `[runtime: gemini]` or similar when intentionally separated
- `summary`, `cron-auto-tag`, or `tasks-auto-tag` show `[runtime: ...]` when fast runtime moved
- the displayed model is a concrete model or a tier resolution like ``capable → anthropic/claude-sonnet-4``

Bad signs:

- `runtime` stayed on the old adapter when you expected a chat runtime swap
- a role literally shows ``openrouter`` or ``codex`` as the model string
- startup logs warn that the runtime is unregistered or missing credentials

## Restart and rebuild rules

### No restart, no rebuild

Use `!models set ...` only.

Examples:

- live chat adapter experiments
- role model overrides written to `models.json`
- voice runtime changes via `!models set voice <runtime>`

### Restart required, rebuild not required

Edit `.env`, then restart.

Examples:

- changing `PRIMARY_RUNTIME`
- changing `OPENROUTER_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`, `CODEX_MODEL`
- changing `DISCOCLAW_TIER_OPENROUTER_FAST/CAPABLE/DEEP`
- adding credentials such as `OPENROUTER_API_KEY`

### Rebuild first, then restart

Only needed when code changed or the installed package was updated.

Source checkout workflow:

```bash
cd ~/code/discoclaw
git pull
pnpm install
pnpm build
```

Then restart after the build succeeds.

## macOS launchd caveat

On macOS, `discoclaw install-daemon` writes a launchd plist with the current `.env` values baked into it.

launchd does not re-read `.env` on `!restart` or `launchctl kickstart`, so editing `.env` alone is not enough.

After changing credentials, `PRIMARY_RUNTIME`, `OPENROUTER_MODEL`, or any `DISCOCLAW_TIER_*` env var on macOS, do one of these:

- rerun `discoclaw install-daemon` from the authoritative working directory
- or manually rewrite and reload the plist with `launchctl bootout ...` and `launchctl bootstrap ...`

A plain restart will reuse the old env snapshot.

## Troubleshooting

### `!models reset` did not return the model I expected

Check the startup-default env vars first:

- `RUNTIME_MODEL`
- `DISCOCLAW_FAST_MODEL`
- `DISCOCLAW_SUMMARY_MODEL`
- `DISCOCLAW_TASKS_AUTO_TAG_MODEL`
- `DISCOCLAW_CRON_MODEL`
- `DISCOCLAW_CRON_AUTO_TAG_MODEL`
- `DISCOCLAW_CRON_EXEC_MODEL`
- `DISCOCLAW_VOICE_MODEL`
- `FORGE_DRAFTER_MODEL`
- `FORGE_AUDITOR_MODEL`
- any `DISCOCLAW_TIER_*` overrides

Also inspect:

- `DISCOCLAW_FAST_RUNTIME` in `.env`
- `voiceRuntime` and `fastRuntime` in `runtime-overrides.json`

### The adapter did not actually switch

Symptoms:

- `!models set chat openrouter` leaves the `runtime` row unchanged
- `!models` shows a literal runtime name as the model string
- logs contain missing credential or missing binary warnings

Fix the missing prerequisite first, restart, then retry.

### I edited `.env`, restarted, and nothing changed

You almost certainly edited the wrong `.env`.

Re-check:

- `systemctl --user show -p WorkingDirectory discoclaw.service`
- the path of the `.env` you edited
- `DISCOCLAW_DATA_DIR` from that same working directory

### Old fast defaults keep returning after restart

You still have a startup or persistent fast-runtime override somewhere.

Inspect all three:

- `.env` for `DISCOCLAW_FAST_RUNTIME`
- `models.json`
- `runtime-overrides.json`

### Voice keeps coming back on the wrong adapter

Inspect:

- `runtime-overrides.json` for `voiceRuntime`
- whether `ANTHROPIC_API_KEY` is auto-registering the voice-only `anthropic` runtime

## AI operator handoff prompt

Use this when another AI agent needs to guide a user through a switch:

```text
Help me switch this DiscoClaw instance to a different runtime adapter or model safely.

First determine whether this is a source checkout or an npm-managed install, and identify the service/unit name plus the authoritative `.env`, `models.json`, and `runtime-overrides.json`.

Then:
1. Show the current effective state with `!models`.
2. Verify the target adapter is actually registered before switching to it. Use `!models` first, and use startup logs if the adapter is missing or looks unregistered.
3. Inspect `.env`, `models.json`, and `runtime-overrides.json`, and call out stale fast/voice runtime overrides before changing anything.
4. Explain which parts are startup defaults from `.env` plus built-in fallbacks versus persistent overrides.
5. If the goal is a persistent adapter switch, update `.env` and clear conflicting overrides.
6. If the goal is OpenRouter tier switching, explicitly inspect or set `DISCOCLAW_TIER_OPENROUTER_FAST`, `DISCOCLAW_TIER_OPENROUTER_CAPABLE`, and `DISCOCLAW_TIER_OPENROUTER_DEEP`, and explain that reverse-mapping is exact-string only.
7. If the goal is a live experiment, use `!models set ...` instead of editing `.env`.
8. After changes, verify with `!models` and service logs.

Do not assume `!models reset` means repo defaults. Treat it as reset-to-this-instance-startup-defaults, and remember that `!models reset chat` does not undo a live chat runtime swap until restart.
```
