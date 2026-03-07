# Runtime and Model Switching Guide

Operator playbook for switching an existing DiscoClaw instance between supported runtime adapters and models.

This is the canonical reference for:

- moving between `claude`, `gemini`, `codex`, `openai`, and `openrouter`
- understanding what `!models` changes live vs. what actually persists
- separating project defaults from instance-specific overrides
- avoiding the common "edited the wrong `.env`" and "`!models reset` didn't do what I expected" traps

Linux `systemd --user` is the primary path described below.

## Before you touch anything

Resolve the actual service/unit name first.

- If `.env` contains `DISCOCLAW_SERVICE_NAME=<name>`, the Linux unit is `<name>.service`.
- If that variable is unset, the default unit is `discoclaw.service`.

Examples below use `discoclaw.service`. Substitute your real unit name everywhere if you run a named multi-instance install.

## macOS launchd caveat

On macOS, `discoclaw install-daemon` writes a launchd plist with the current `.env` values baked into it. launchd does not re-read `.env` on `!restart` or `launchctl kickstart`, so editing `.env` alone is not enough.

After changing adapter credentials, `PRIMARY_RUNTIME`, tier overrides, or model env vars on macOS, do one of these:

- rerun `discoclaw install-daemon` from the authoritative working directory
- or manually rewrite/reload the plist with `launchctl bootout ...` and `launchctl bootstrap ...`

A plain restart only restarts the old plist with the old env snapshot.

## Three layers that matter

There are three different sources of truth involved in runtime/model selection:

| Layer | What it controls | Where it lives | How it changes |
| --- | --- | --- | --- |
| Built-in defaults | Baseline role defaults and tier maps shipped by the repo | Code (`src/model-config.ts`, `src/runtime/model-tiers.ts`) | Changes only when the software version changes |
| Startup defaults for *this instance* | What the service boots with before live overrides | Usually the service working directory `.env`, plus built-in fallbacks when env vars are absent | Edit `.env`, then restart |
| Persistent live overrides | Role/model/runtime changes made after startup | `models.json` and `runtime-overrides.json` under the data dir | `!models ...` and runtime auto-switches |

The most important rule:

`!models reset` resets back to this instance's startup defaults as resolved at boot from `.env` plus built-in fallbacks, not back to repo defaults and not back to whatever the docs happen to show.

Also keep the files separate in your head:

- `models.json` stores per-role model strings only.
- `runtime-overrides.json` stores runtime-only overlays such as `voiceRuntime`, `fastRuntime`, and `ttsVoice`.
- A missing `runtime-overrides.json` file is normal on a fresh or fully reset instance.

## What the project ships by default

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

`openrouter` does not have a built-in tier map. Its adapter default comes from `OPENROUTER_MODEL`, and tier auto-switching only works if you define `DISCOCLAW_TIER_OPENROUTER_FAST/CAPABLE/DEEP` yourself.

### OpenRouter tier map recipe

If you want `fast`, `capable`, and `deep` to auto-switch into OpenRouter, define all three tier env vars with the exact model strings you expect DiscoClaw to reverse-map later:

```bash
DISCOCLAW_TIER_OPENROUTER_FAST=openai/gpt-5-mini
DISCOCLAW_TIER_OPENROUTER_CAPABLE=anthropic/claude-sonnet-4
DISCOCLAW_TIER_OPENROUTER_DEEP=google/gemini-2.5-pro
```

Then restart the service. After that:

- `!models set chat openrouter` can use those tier names as OpenRouter-backed defaults
- `!models set fast openai/gpt-5-mini` can auto-switch the fast runtime to `openrouter`
- the match is exact-string only, so use the same provider/model IDs everywhere

## Find the right instance files first

Do this before changing anything.

### Source checkout

You are in source mode when the service working directory is the repo and that directory has a `.git` folder.

Typical authoritative files:

- `.env`: repo root, for example `~/code/discoclaw/.env`
- `models.json`: `$DISCOCLAW_DATA_DIR/models.json`, otherwise `./data/models.json` under the repo root
- `runtime-overrides.json`: `$DISCOCLAW_DATA_DIR/runtime-overrides.json`, otherwise `./data/runtime-overrides.json`

### npm-managed install

You are in npm-managed mode when the package is installed without a `.git` directory at the package root. The important detail is that the package install location is not where you should edit config.

Typical authoritative files:

- `.env`: the service working directory created during `discoclaw init`
- `models.json`: under that instance's data dir
- `runtime-overrides.json`: under that instance's data dir

For Linux systemd installs, the service reads `.env` from its working directory on every restart. In practice, the working directory is the authoritative location to inspect.

### Reliable detection steps

1. Find the service working directory.
   Linux:
   ```bash
   systemctl --user show -p WorkingDirectory discoclaw.service
   systemctl --user cat discoclaw.service
   ```
2. Go to that directory and inspect it.
   - If it contains `.git`, treat it as a source checkout.
   - If it has `.env` and workspace/data files but no `.git`, treat it as an npm-managed instance directory.
3. Only edit files in that working directory (or its configured data dir).

If you edit a different clone's `.env`, nothing changes.

### Minimum inspection set

For a safe operator handoff, always inspect these four things together:

```bash
sed -n '1,200p' .env
sed -n '1,200p' "${DISCOCLAW_DATA_DIR:-./data}/models.json"
sed -n '1,200p' "${DISCOCLAW_DATA_DIR:-./data}/runtime-overrides.json"
journalctl --user -u discoclaw.service -n 100 --no-pager
```

If `DISCOCLAW_DATA_DIR` is only set inside `.env` and not exported in your current shell, read it from `.env` first and substitute that absolute path manually. A missing `runtime-overrides.json` file is still a valid state.

Interpret them like this:

- `.env` defines startup defaults and credentials.
- `models.json` shows persistent per-role model choices.
- `runtime-overrides.json` shows persistent fast/voice/TTS runtime overlays.
- `journalctl` shows whether the target adapter actually registered at startup.

## Which setting lives where

| Change you want | Persistent home | Notes |
| --- | --- | --- |
| Default chat adapter at startup | `.env` `PRIMARY_RUNTIME` | Restart required |
| Adapter default model | `.env` `CODEX_MODEL`, `GEMINI_MODEL`, `OPENAI_MODEL`, `OPENROUTER_MODEL` | Used when a role is set to the adapter default |
| Tier mapping for a runtime | `.env` `DISCOCLAW_TIER_<RUNTIME>_<TIER>` | Controls how `fast/capable/deep` resolve |
| Per-role persistent model override | `models.json` | Written by `!models set <role> <tier-or-model>` |
| Persistent voice runtime override | `runtime-overrides.json` | Written by `!models set voice <runtime>` or voice auto-switch |
| Persistent fast-tier runtime override | `runtime-overrides.json` | Written when fast auto-switches to another runtime |
| TTS voice override | `runtime-overrides.json` | Separate from model/runtime switching, but often present when auditing overrides |

## Adapter prerequisites

Do not try to switch into an adapter that is not actually configured.

| Adapter | Startup-supported via `PRIMARY_RUNTIME` | Needs |
| --- | --- | --- |
| `claude` | yes | Claude CLI available |
| `gemini` | yes | `GEMINI_API_KEY` or Gemini CLI |
| `codex` | yes | Codex CLI |
| `openai` | yes | `OPENAI_API_KEY`; also set `OPENAI_COMPAT_TOOLS_ENABLED=1` for full tool use |
| `openrouter` | yes | `OPENROUTER_API_KEY`; also set `OPENAI_COMPAT_TOOLS_ENABLED=1` for full tool use |
| `anthropic` | no | Voice-only runtime; `ANTHROPIC_API_KEY` |

`anthropic` is not a supported `PRIMARY_RUNTIME` value. It is a special direct Messages API runtime that may auto-register for voice use when `ANTHROPIC_API_KEY` is present.

## Verify adapter registration before switching

Do this before trusting a runtime name like `openrouter`, `openai`, `gemini`, `codex`, or `anthropic`.

1. Run `!models` and note the current runtime row plus any `[runtime: ...]` annotations on `voice`, `summary`, `cron-auto-tag`, or `tasks-auto-tag`.
2. If the adapter you expect to use is already active anywhere, confirm `!models` shows a concrete model for that path, not a literal runtime name where a model should be.
3. If the target adapter is not currently active on any role, remember that `!models` only shows active paths. Use startup logs to confirm registration before you trust the switch.
4. If a role shows the runtime name literally instead of switching adapters, treat it as unregistered.
5. Check startup logs:

```bash
journalctl --user -u discoclaw.service -n 100 --no-pager
```

Look for missing credential or missing binary warnings at startup. For stale overrides, the most useful warnings are:

- `runtime-overrides: voiceRuntime is not a registered runtime; ignoring`
- `runtime-overrides: fastRuntime is not a registered runtime; ignoring`
- `DISCOCLAW_FAST_RUNTIME is not registered; falling back to PRIMARY_RUNTIME`

Do not use `!health` for this check. `!health` does not show runtime adapter registration status.

## How each role switches

Not every role behaves the same way.

| Role | What `!models set` changes | Runtime switch behavior |
| --- | --- | --- |
| `chat` | Chat model in `models.json` when you set a tier/model; runtime name is live-only | `!models set chat <runtime>` swaps runtime live, but does **not** persist the runtime name |
| `fast` | Fast-tier model in `models.json` | Runtime auto-switches only when the concrete model belongs to another runtime's tier map; that runtime override persists |
| `summary` | Summary model in `models.json` | No separate runtime; uses fast runtime |
| `cron` | Cron auto-tag/model-classification model in `models.json` | No separate runtime; uses fast runtime |
| `cron-exec` | Default cron execution model in `models.json` | No separate runtime; follows chat runtime |
| `forge-drafter` | Drafter model in `models.json` | No separate runtime; follows chat runtime unless env says otherwise |
| `forge-auditor` | Auditor model in `models.json` | No separate runtime; follows chat runtime unless env says otherwise |
| `voice` | Voice model in `models.json` | `!models set voice <runtime>` persists a voice runtime override; a concrete model from another provider can also auto-switch voice runtime |

This means:

- if you want a **persistent primary adapter change**, edit `.env`
- if you want a **live chat experiment until restart**, use `!models set chat <runtime>`
- if you want **voice to stay on a different adapter across restarts**, `!models set voice <runtime>` is valid

## Legacy fast-runtime override

`DISCOCLAW_FAST_RUNTIME` is deprecated. Prefer `!models set fast <model>`, which writes the fast model to `models.json` and auto-switches the fast runtime when the chosen concrete model belongs to another runtime's tier map.

The legacy env var still matters in two ways:

- it is still read at startup and can seed the fast runtime before any live changes
- `runtime-overrides.json` can replace it later if a persistent fast-runtime override exists

That interaction is easy to miss:

- startup order is effectively `.env` first, then `runtime-overrides.json`
- `!models reset fast` clears the live/file-backed fast override, but it does **not** remove `DISCOCLAW_FAST_RUNTIME` from `.env`
- after the next restart, the legacy env var can take effect again unless you delete or change it

If you are cleaning up an old instance, inspect both `.env` and `runtime-overrides.json`.

## Safe switch recipes

### 1. Persistently switch the whole instance to another adapter

Use this when the startup/runtime default should permanently move.

1. Edit the authoritative `.env`.
2. Set `PRIMARY_RUNTIME` to one of `claude`, `gemini`, `codex`, `openai`, `openrouter`.
3. Set or verify the adapter-specific default model if you want adapter default behavior:
   - `GEMINI_MODEL`
   - `CODEX_MODEL`
   - `OPENAI_MODEL`
   - `OPENROUTER_MODEL`
4. Remove or reset any role overrides that should stop fighting the new default:
   - `!models reset chat`
   - `!models reset fast`
   - `!models reset summary`
   - `!models reset cron`
   - `!models reset cron-exec`
   - `!models reset voice`
   - `!models reset forge-drafter`
   - `!models reset forge-auditor`
5. If you rotated credentials through Discord DMs, `!secret set KEY=value` can update the authoritative `.env` in place, for example:

```text
!secret set OPENAI_API_KEY=sk-...
!secret set OPENROUTER_API_KEY=sk-or-...
```

`!secret` writes the file only. It does **not** restart DiscoClaw automatically, so you must restart the bot yourself after changing credentials.

6. Restart the service.
7. Verify with `!models`.

If the service is source-managed and you only changed `.env`, no rebuild is needed. Restart is enough.

### 2. Live-switch chat to another adapter without touching startup defaults

Use this to test another adapter immediately.

```text
!models set chat codex
!models set chat openrouter
!models set chat gemini
```

Before running one of those, do the adapter-registration check above so you know the target runtime actually exists.

Expected result in `!models`:

- `runtime` row changes to the new adapter
- `chat` usually becomes that adapter's default model

Important:

- this runtime swap is live-only and is lost on restart
- if the adapter is not registered, DiscoClaw treats the runtime name like a literal model string instead of erroring

Bad verification pattern:

- `runtime` still says `claude`
- `chat` now literally says ``openrouter`` or ``codex``

That means you did not switch runtimes. Reset the role, configure the adapter properly, and retry.

### 3. Switch chat to a different model on the current adapter

Use either a tier or a concrete model string:

```text
!models set chat capable
!models set chat gpt-5.4
!models set chat anthropic/claude-sonnet-4
```

This persists to `models.json`.

Tier names resolve against the current runtime's tier map. Concrete model strings pass through unchanged.

### 4. Switch the fast tier to another provider/model

```text
!models set fast gemini-2.5-flash
!models set fast gpt-5-mini
!models set fast fast
```

Fast runtime auto-switch only happens when the chosen concrete model can be reverse-mapped to another runtime's tier map.

Out of the box this works best for Claude/Gemini/OpenAI/Codex default tier models. It does **not** automatically infer `openrouter` from an arbitrary provider/model string unless you defined `DISCOCLAW_TIER_OPENROUTER_*` in `.env`.

### 5. Switch voice independently

Examples:

```text
!models set voice gemini
!models set voice codex
!models set voice capable
!models set voice gemini-2.5-flash
```

Verification pattern in `!models`:

- `voice` line should show `[runtime: <adapter>]` when voice differs from chat

Voice runtime overrides persist across restart because they are stored separately from `models.json`.

### 6. Switch forge / cron / summary roles

Examples:

```text
!models set forge-drafter capable
!models set forge-auditor deep
!models set cron fast
!models set cron-exec default
!models set summary fast
```

`cron-exec default` is the one special reset-like value for that role; it clears the explicit override and returns cron execution to the startup default for `cron-exec`.

## Verification checklist

After any switch:

1. Run `!models`.
2. Confirm the runtime row and the affected role match what you intended.
3. Confirm the target adapter is actually registered:
   - a successful chat runtime switch changes the `runtime` row
   - a successful voice/fast runtime switch adds `[runtime: <adapter>]` to the affected role paths
   - a failed registration attempt often leaves the runtime row unchanged and stores the runtime name literally as the model string
4. If you edited `.env`, restart the service and run `!models` again.
5. If startup fails, inspect service status/logs before changing more settings.

Good signs in `!models`:

- `runtime` changed when you intended a chat adapter switch
- `voice` shows `[runtime: gemini]` or similar when voice is intentionally separate
- summary/cron/task auto-tag rows show `[runtime: ...]` when fast runtime moved
- override markers only appear on roles you intentionally changed

## Restart and rebuild decision tree

### No rebuild, no restart

Use `!models set ...` only.

This is enough for:

- live chat model changes
- live chat adapter experiments
- persistent `models.json` overrides

### Restart required, rebuild not required

Edit `.env`, then restart.

This is enough for:

- changing `PRIMARY_RUNTIME`
- changing adapter default model env vars like `CODEX_MODEL`
- changing tier maps like `DISCOCLAW_TIER_OPENAI_CAPABLE`
- enabling adapter credentials or tool support

### Rebuild first, then restart

Only needed when you changed source code or updated the installed software.

Source checkout workflow:

```bash
cd ~/code/discoclaw
git pull
pnpm install
pnpm build
```

Then restart after the build succeeds.

## Troubleshooting

### `!models reset` did not return the model I expected

`!models reset` goes back to startup defaults from `.env` plus built-in fallbacks, not to repo defaults. Check:

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

Also check `DISCOCLAW_FAST_RUNTIME` if fast-path roles keep coming back to the wrong runtime after a restart. `!models reset` does not remove that legacy env var.

If voice seems to reset to the wrong adapter, inspect `runtime-overrides.json` for `voiceRuntime` and check whether `ANTHROPIC_API_KEY` is auto-wiring voice to `anthropic` at boot.

### Adapter not actually registered

Symptoms:

- `!models set chat openrouter` leaves `runtime` unchanged
- `!models` shows a literal runtime name as the model string
- startup logs contain warnings about unregistered runtimes or missing prerequisites

Checks:

```bash
journalctl --user -u discoclaw.service -n 100 --no-pager
```

Look for warnings like:

- `runtime-overrides: voiceRuntime is not a registered runtime; ignoring`
- `runtime-overrides: fastRuntime is not a registered runtime; ignoring`
- missing API key warnings for `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY`
- missing CLI/binary warnings for Claude, Gemini, or Codex startup paths

Fix the missing credential or binary first, restart, then verify again with `!models`.

### I switched adapters, but `!models` still shows the old runtime

You likely set a literal model string instead of activating a registered runtime. The adapter is missing prerequisites or credentials.

Fix:

1. Configure the adapter first.
2. Reset the bad role override.
3. Retry the switch.

### The wrong defaults keep winning after restart

You still have persistent overrides. Inspect:

- `models.json`
- `runtime-overrides.json`
- `!models` override markers

### I edited `.env`, restarted, and nothing changed

You probably edited the wrong `.env`. Re-check the service working directory and `DISCOCLAW_DATA_DIR`.

### Stale docs copied only at bootstrap

Old workspace copies of `workspace/TOOLS.md` or `workspace/AGENTS.md` may still mention outdated model names or adapter lists. Those files do not control runtime registration.

Prefer the current repo docs, live `!models` output, `.env`, `models.json`, and `runtime-overrides.json` when deciding what the instance can actually use.

### Wrong working directory

You likely edited a different clone's `.env` or data dir.

Checks:

- compare `systemctl --user show -p WorkingDirectory discoclaw.service`
- compare the `.env` path you edited
- compare `DISCOCLAW_DATA_DIR` in that same working directory

If those point at different clones, only one of them is authoritative.

### Old docs or copied workspace files say something different

Prefer the repo docs plus live command output over old bootstrap copies. Runtime behavior is determined by current code, `.env`, `models.json`, and `runtime-overrides.json`, not by whatever was scaffolded into a workspace months ago.

## AI operator prompt

Use this when guiding someone through an adapter/model switch:

```text
Help me switch this DiscoClaw instance to a different runtime adapter or model safely.

First determine whether this is a source checkout or an npm-managed install, and identify the service/unit name plus the authoritative `.env`, `models.json`, and `runtime-overrides.json`.

Then:
1. Show the current effective state with `!models`.
2. Verify the target adapter is actually registered before switching to it. Use `!models` to confirm the current runtime/role output is sane, and if the adapter is missing or looks unregistered, inspect startup logs instead of guessing.
3. Inspect `.env`, `models.json`, and `runtime-overrides.json`, and call out any stale fast/voice runtime overrides before changing anything.
4. Explain which parts are startup defaults from `.env` plus built-in fallbacks versus persistent overrides.
5. If the goal is a persistent adapter switch, update `.env` and clear conflicting overrides.
6. If the goal is a live experiment, use `!models set ...` instead of editing `.env`.
7. After changes, verify with `!models` and service status/logs if needed.

Do not assume `!models reset` means repo defaults; treat it as reset-to-this-instance-startup-defaults.
```
