# Codex Native Forge Route Audit

Date range: March 12-14, 2026

Primary task thread: `ws-1223` ("Restore forge auditor to Codex after ws-1222")

## Purpose

This document captures the hard-won findings from the multi-day harness and live-run audit of DiscoClaw's Codex native app-server forge route.

The main goal of the investigation was to answer a narrower question than "does forge work?":

- Why does native Codex/app-server work in some cases but wedge or stall in forge?
- Which failures are transport/runtime bugs versus prompt/workflow bugs?
- What fixes already landed?
- What still remains open?

This is intentionally more detailed than `docs/compound-lessons.md`. It is the working audit memo for the Codex-native forge route.

## Executive Summary

The remaining native forge problem is not a single generic "app-server is broken" issue.

The audit established four separate classes of problems:

1. Real transport/lifecycle failures existed and were fixed.
   - websocket disconnects
   - dead local app-server listener
   - stale session/thread reuse after disconnect or cancel
   - silent hangs with no terminal failure

2. Forge-specific orchestration bugs existed and were fixed.
   - watchdog/progress messages going stale
   - plan artifacts being overwritten or malformed on failure
   - same-thread native retry contamination
   - CLI salvage parser/guard bugs

3. The remaining "pure native" blocker was not mainly transport.
   - bounded native grounding can now work, but it is nondeterministic
   - native audit turns generally stream and complete
   - native revision-shaped turns remain the least reliable category

4. The strongest remaining native write-turn trigger was prompt context shape.
   - native draft-write worked with no extra context
   - native draft-write also worked with a reduced workspace identity context bundle
   - native draft-write repeatedly stalled when it inherited workspace `AGENTS.md`
   - repo `project.md` alone also reproduced a stall in direct probes
   - the effect was not purely size-based; it was prompt-shape sensitive and somewhat model-sensitive

Current status at the end of this pass:

- Forge is usable again through the harness because CLI salvage recovers the unstable native revision phases.
- Native draft grounding is materially improved.
- Native draft-write was reproduced working after filtering the native write context.
- Native audit was later reproduced completing cleanly as well.
- Pure-native revision is still not reliable; both bounded revision grounding and direct revision-write probes can go fully silent with no text.

## What Was Proved

### 1. Early failures were real transport/lifecycle bugs

These were not hallucinated by the harness.

Confirmed failures included:

- local app-server listener missing entirely, causing fallback to CLI
- websocket close mid-turn with close code `1006`
- native turns that started but never emitted a terminal event
- runs stuck in watchdog `running` with no artifact progress
- retries reusing contaminated native session/thread state

Important operational finding:

- `codex-app-server.service` was allowed to stay dead because its unit was configured with `Restart=on-failure` and had exited cleanly.
- Local ops mitigation was to force `Restart=always`.
- This was an environment/systemd issue, not a repo-code issue by itself.

### 2. Native audit and native draft/revision did not behave the same

This was one of the most important findings.

Using the same native app-server transport and the same model family:

- native auditor turns usually started `agentMessage` text quickly and completed
- native drafter/revision turns often did tool/reasoning work and emitted no answer text before stalling

This ruled out the overly-broad theory that "native Codex chat is just broken."

The failure was phase-shape specific.

### 3. The forge `Read`/`Glob`/`Grep` tool contract is not a real Codex-side contract

Forge modeled Codex grounding as if it had a typed read-only file-tool contract:

- `Read`
- `Glob`
- `Grep`

But Codex CLI and app-server do not actually receive that contract from DiscoClaw.

What the audit proved:

- Forge prompts assumed a Claude-style file-tool model
- Codex adapters did not send a per-invoke `Read`/`Glob`/`Grep` allowlist
- In practice, Codex used generic shell-style `command_execution`
- That explains the broad repo wandering (`rg`, `git show`, reading old plans, guidance files, etc.)

This mattered because it collapsed one false theory:

- the remaining grounding failure was not "native app-server only"
- the same open-ended research prompt shape also over-researched on the CLI path

### 4. Open-ended discovery plus strict output contracts is a bad Codex shape

This held on both native and CLI Codex.

Patterns that failed:

- tool-enabled grounded discovery plus "reply only with file paths"
- durable final-only artifact generation while still implicitly expecting more research
- single-turn "inspect repo, then produce final plan artifact" shapes

Patterns that worked better:

- bounded candidate selection from a precomputed file list
- no-tools path selection turns
- smaller write-only turns after the grounded inputs were already fixed

This led to the two-stage native draft/revision design:

1. grounded candidate selection
2. write the artifact from already-bounded inputs

### 5. The remaining native write-turn failure was prompt-context sensitive

This was the latest major breakthrough.

Direct write-turn probes showed:

- current write prompt with no extra project context: native streamed `# Plan:` and completed
- smaller Codex-specific write prompt: native streamed and completed
- current write prompt with the old compact context bundle: native stalled with no text

Then the context bundle was split apart.

The most important results:

- `AGENTS.md` alone was enough to reproduce the native write-turn no-text stall
- repo `project.md` alone also reproduced the stall in a direct probe
- `SOUL.md + IDENTITY.md + USER.md + TOOLS.md` still allowed native write-turn success
- `project.md + compound-lessons.md` unexpectedly succeeded in one probe, which means the effect is not a simple monotonic size threshold

Conclusion:

- the native write-turn problem is strongly affected by context shape
- it is not just "too many characters"
- workspace `AGENTS.md` was the most consistently toxic source during this audit

## False Leads That Were Ruled Out

These were investigated and should not be reopened casually without new evidence.

### "It is just a generic websocket bug"

False as a complete explanation.

There were real websocket issues, but later failures still reproduced even when:

- the socket stayed open
- the app-server stayed healthy
- audit turns continued to work natively

### "It is just a parser bug"

Incomplete.

A real parser gap existed:

- final answer text in `turn.completed.turn.items` could be dropped if no earlier deltas had populated the cached final text

That was patched, but it did not explain the main forge draft stalls, because those turns often never reached `turn/completed` before fallback.

### "It is just prompt length"

False by itself.

Prompt bulk mattered, but it was not the whole story.

Examples:

- reducing the draft-write prompt from roughly `43k` chars to roughly `30k` chars did not clear the stall
- a much smaller prompt with the wrong context still stalled
- a larger prompt with the right reduced context could still stream and complete

### "It is just tool use"

Incomplete.

Open-ended tool-enabled discovery was clearly bad, but even no-tools write turns could fail when the context bundle was wrong.

### "It is just the durable-artifact wording"

Also incomplete.

The durable/final-only artifact framing did correlate with failures, but the direct probes showed the context bundle was at least as important as the artifact contract itself.

## Key Fixes Landed During The Audit

This section is not a full changelog. It records the fixes that materially changed the investigation or product behavior.

### Transport and runtime hardening

- classified native Codex failures by type and normalized runtime failures
- added better native lifecycle logs (`thread/start`, `turn/start`, first notification, first progress, completion/failure)
- added websocket keepalive pings and close-code logging
- cleared native session state on websocket loss
- treated native disconnects as retryable in the forge paths that could recover safely
- added native liveness guards for no-output/progress-stall cases

### Forge loop and artifact hardening

- prevented runtime error text from overwriting forge artifacts
- stopped watchdog from overwriting completed normal chat replies
- fixed stale forge "still running" notices and run-state mismatches
- preserved plan header/tail sections across salvage retries and revisions
- made grounding contract failures fail fast instead of burning the full stall window
- stopped same-thread inner retries after grounding-guard interrupts

### Salvage and fallback hardening

- added explicit CLI salvage retries when native forge phases failed in specific recoverable ways
- fixed Codex CLI reasoning parsing so reasoning items did not poison the `# Plan:` output guard
- preserved the plan tail (`## Audit Log`, `## Implementation Notes`) during salvage merges

### Repro and diagnostics

- added `scripts/forge-native-repro.ts`
- added notification tracing and CLI stdio tracing
- used the harness to separate transport failures from prompt-shape failures

## Key Harness Runs

These are the most important reproducible checkpoints.

### `plan-538`

What it proved:

- native bounded grounding emitted valid path output
- a local guard bug rejected correct output because streamed `text_delta` and final `text_final` were both counted

Consequence:

- fixed the grounding-output guard

### `plan-539`

What it proved:

- bounded native grounding could succeed
- the next blocker moved to native draft-write

Consequence:

- stopped treating grounding as the main pure-native blocker

### `plan-526`

What it proved:

- forge was usable again when salvage was allowed to recover native failures
- silent hangs were no longer the only outcome

Important caveat:

- completion still depended on CLI salvage for draft/revision

### `plan-542`

Trace:

- [trace.jsonl](/home/davidmarsh/Dropbox/discoclaw-data/workspace/diagnostics/forge-native-repro/20260314T000125Z-plan-502/trace.jsonl)

What it proved:

- native draft grounding completed
- native draft-write completed
- forge advanced into native audit round 1

This was the first strong evidence that the filtered native write-context patch cleared the specific pure-native draft-write stall.

Important caveat:

- `plan-542` ended `CANCELLED` because the harness was manually stopped during audit to avoid leaving a long traced run active
- it was not the old draft-write no-text stall recurring

Saved artifact:

- [plan-542-restore-forge-auditor-to-codex-after-ws-1222.md](/home/davidmarsh/Dropbox/discoclaw-data/workspace/plans/plan-542-restore-forge-auditor-to-codex-after-ws-1222.md)

### `plan-543`

What it proved:

- the filtered native write-context patch cleared the old native draft-write failure in a normal harness run, not just a direct probe
- native draft grounding completed
- native draft-write completed
- forge advanced into native audit on the same branch without needing draft salvage

Important caveat:

- this run was stopped while audit was still in flight, so it did not answer whether native audit was actually hung versus just long-running

### `plan-544`

Trace:

- [trace.jsonl](/home/davidmarsh/Dropbox/discoclaw-data/workspace/diagnostics/forge-native-repro/20260314T150442Z-plan-502/trace.jsonl)

What it proved:

- native draft grounding completed with a terminal `turn/completed` payload that contained the concrete grounded file-path list
- native draft-write streamed `# Plan:` output and completed cleanly
- native audit was not transport-dead; it emitted continuous `item/agentMessage/delta` text and tool activity for minutes
- the old "quiet audit means wedged audit" assumption was too aggressive

Important caveat:

- the traced run was manually stopped because notification-level tracing was too noisy to leave running interactively

### `plan-545`

What it proved:

- native draft grounding completed
- native draft-write completed
- native audit round 1 completed natively in about `3m 27s`
- the next real blocker moved to revision

Revision-specific findings:

- native revision grounding completed
- native revision write then failed with `codex_app_server_progress_stall` after `45000ms` with no text output
- forge correctly escalated to CLI salvage instead of hanging
- CLI revision salvage then stalled repeatedly too:
  - `codex exec --json` produced stdout bytes
  - no parsed events were emitted
  - each salvage attempt hit a `120000ms` stream stall

Conclusion from `plan-545`:

- native draft is no longer the primary blocker
- native audit is no longer the primary blocker
- the remaining forge reliability problem is revision write plus revision salvage

### `plan-546`

Trace:

- [trace.jsonl](/home/davidmarsh/Dropbox/discoclaw-data/workspace/diagnostics/forge-native-repro/20260314T152736Z-plan-502/trace.jsonl)

What it proved:

- the run remained nondeterministic by phase shape:
  - native draft grounding completed
  - native draft-write hit a `45000ms` no-text `codex_app_server_progress_stall`
  - forge escalated to CLI draft salvage
- CLI draft salvage was not parser-dead:
  - raw stdout began almost immediately
  - the first parsed runtime event arrived much later as `thinking_delta`
  - the attempt still completed successfully and produced a final plan artifact
- native audit then started again and continued natively

Conclusion from `plan-546`:

- the Codex CLI parser can survive long reasoning-only lead-in on salvage attempts
- the earlier revision-salvage suspicion narrowed from "CLI parser may be broken in general" to "something about the revision retry path is different"

### `plan-547`

Trace:

- [trace.jsonl](/home/davidmarsh/Dropbox/discoclaw-data/workspace/diagnostics/forge-native-repro/20260314T155132Z-plan-502/trace.jsonl)

What it proved:

- the latest local branch completed end-to-end through the harness
- native draft grounding completed
- native draft-write completed
- native audit round 1 completed natively
- native revision after round 1 still hit a `45000ms` no-text `codex_app_server_progress_stall`
- CLI revision salvage after round 1 succeeded cleanly
- native audit round 2 completed natively
- native revision after round 2 hit the same native no-text stall
- CLI revision salvage after round 2 also succeeded cleanly
- audit round 3 completed natively and the forge finished in `3` rounds with `Verdict: medium`

The new CLI diagnostics removed the old ambiguity:

- both live revision salvage attempts produced valid JSONL
- both reached `turn.completed`
- neither produced unparsable stdout
- both were parsed and handled by the Codex strategy parser

Concrete live numbers from `plan-547`:

- revision salvage after round 1:
  - `stdoutLineCount: 11`
  - `parsedJsonLineCount: 11`
  - `unparsableStdoutLineCount: 0`
  - `lastJsonEventType: "turn.completed"`
- revision salvage after round 2:
  - `stdoutLineCount: 7`
  - `parsedJsonLineCount: 7`
  - `unparsableStdoutLineCount: 0`
  - `lastJsonEventType: "turn.completed"`

Conclusion from `plan-547`:

- the current branch is forge-usable again through the harness
- the earlier "CLI revision salvage may be parser-dead" theory is no longer supported
- the remaining reliability issue is narrower: native revision still stalls before salvage, but `plan-547` alone did not yet prove whether the failing native sub-step was revision grounding or revision write

### Native revision-grounding direct probes after `plan-547`

What the later direct probes proved:

- the failing native sub-step in `plan-547` was the bounded revision-grounding turn, not revision-write
- in the `plan-547` trace, the only native drafter turn before each revision fallback had prompt sizes that match the bounded revision-grounding candidate-selection prompt:
  - draft grounding: `promptChars: 3157`
  - draft write: `promptChars: 9832`
  - revision round 1 grounding: `promptChars: 10262`
  - revision round 2 grounding: `promptChars: 11346`
- there was no second native drafter `turn/start` between revision grounding and the CLI salvage, so the native write step was never reached in those failing revision cycles

Direct probe results using the exact forge-style bounded revision-grounding prompt with the real 24-path candidate list:

- a first direct fresh-session probe succeeded natively and returned text after about `19.6s`
- a same-session probe after a successful prior native write stalled with `progress stall: no runtime progress for 30000ms`
- an immediate fresh-session control probe also stalled
- a 4-trial fresh-session repeat against the exact same prompt and runtime split `1 success / 3 stalls`
- one successful repeat returned concrete file-path lines, not `NONE`, while the failed repeats produced no text at all

What that means:

- the remaining native forge problem is not just "revision write is too large"
- the unstable step is bounded native revision grounding
- the exact same native revision-grounding prompt is nondeterministic: it can either emit valid path output or go completely silent with no text
- same-session history may worsen the issue, but it is not the sole cause, because fresh-session repeats also split between success and stall

Implication:

- this now looks like native model/app-server instability on the bounded revision-grounding prompt shape itself, not a deterministic parser bug and not a generic websocket transport failure

### Direct native revision-write probes after the grounding repeat test

What I tested:

- the exact native revision-write prompt shape with `groundedInputs = NONE`
- once without the compact write-context bundle
- once with the compact write-context bundle currently used for native Codex draft/revision write turns

Results:

- `none_no_context` stalled with `progress stall: no runtime progress for 30000ms`
- `none_compact_context` also stalled with the same no-text error
- an additional compact revision-write probe using only:
  - a short objective
  - a shortened `## Changes` path list
  - the audit JSON block
  still stalled with the same no-text error at about `30s`

What that means:

- skipping revision grounding is not an immediate pure-native fix
- at least in these direct probes, native revision-write itself is also capable of going fully silent
- aggressive prompt summarization alone did not recover native revision-write in the latest probe
- the current forge success story is therefore narrower than "only grounding is broken"

Updated interpretation:

- native revision grounding is confirmed unstable and nondeterministic
- native revision write is also not yet proven reliable enough to replace the salvage path directly
- the current branch is forge-usable because CLI salvage recovers these revision phases, not because pure-native revision is solved

### Direct CLI replay of the compact revision salvage prompt

Artifacts:

- Prompt file: `/tmp/revision-salvage-prompt.7xMf6x.txt`
- Raw Codex JSONL: `/tmp/revision-salvage-out.UcEiDm.jsonl`

What it proved:

- the exact compact revision retry prompt shape can succeed on `codex exec --json`
- Codex emitted valid JSONL, not malformed/non-JSON output
- the output included:
  - multiple `item.completed` records of type `reasoning`
  - a final `item.completed` record of type `agent_message`
  - a terminal `turn.completed`
- the revision retry prompt therefore is not inherently incompatible with Codex CLI, and the parser is not obviously incapable of handling that prompt shape

Conclusion from the direct replay:

- the remaining revision-salvage failure is more likely tied to the forge retry path, subprocess/stream timing, or some other runtime-state difference around the live revision retry
- it is much less likely that the prompt itself always produces unusable Codex output

### CLI adapter diagnostics added after the direct replay

What changed locally:

- [src/runtime/cli-adapter.ts](/home/davidmarsh/code/discoclaw/src/runtime/cli-adapter.ts) now logs stdout parse diagnostics in both stall logs and the final timing summary
- [src/runtime/cli-adapter.test.ts](/home/davidmarsh/code/discoclaw/src/runtime/cli-adapter.test.ts) now covers those diagnostics

New fields now captured for CLI one-shot attempts:

- `stdoutLineCount`
- `parsedJsonLineCount`
- `unparsableStdoutLineCount`
- `strategyHandledLineCount`
- `defaultHandledLineCount`
- `lastStdoutLinePreview`
- `lastUnparsableStdoutLinePreview`
- `lastJsonEventType`

Why this matters:

- the next live revision-salvage failure should tell us whether Codex is producing:
  - no line-delimited stdout at all
  - valid JSON lines that DiscoClaw is not turning into runtime events
  - non-JSON/unparseable lines
- this should be enough to decide whether the remaining bug is parser classification, subprocess/stream behavior, or a retry-path state issue

## Current Local Patch State

As of this memo, the latest local code work is in:

- [src/discord/forge-commands.ts](/home/davidmarsh/code/discoclaw/src/discord/forge-commands.ts)
- [src/discord/forge-commands.test.ts](/home/davidmarsh/code/discoclaw/src/discord/forge-commands.test.ts)
- [src/runtime/cli-adapter.ts](/home/davidmarsh/code/discoclaw/src/runtime/cli-adapter.ts)
- [src/runtime/cli-adapter.test.ts](/home/davidmarsh/code/discoclaw/src/runtime/cli-adapter.test.ts)
- [docs/audit/codex-native-forge-route-audit.md](/home/davidmarsh/code/discoclaw/docs/audit/codex-native-forge-route-audit.md)

The key local change is:

- native Codex draft/revision write turns now use a filtered context bundle built from workspace `SOUL.md`, `IDENTITY.md`, `USER.md`, and `TOOLS.md`
- forge now forces Codex phases onto the CLI route by default instead of the native app-server path while the pure-native revision investigation remains open
- that filtered bundle intentionally excludes:
  - workspace `AGENTS.md`
  - repo `project.md`
  - repo `compound-lessons.md`

The reason for that filter is empirical:

- that reduced context bundle reproduced native write success in direct probes
- the broader inherited context bundle repeatedly reproduced the native no-text stall

Verification completed for the local patch:

- `pnpm exec vitest run src/discord/forge-commands.test.ts`
- `pnpm exec vitest run src/runtime/cli-adapter.test.ts`
- `pnpm build`

## Remaining Open Questions

The investigation is narrower now, but not finished.

Open questions:

- Why is the bounded native revision-grounding prompt nondeterministic on the exact same input, alternating between valid path output and no-text stalls?
- Does prior native drafter-thread history materially change the success rate of bounded revision grounding, or is the instability mostly intrinsic to the prompt shape itself?
- Is native revision-write fundamentally subject to the same no-text failure mode even when grounding is skipped, or did the direct `NONE` probes hit another unstable corner of the prompt space?
- Is the toxic effect of `AGENTS.md` stable and reproducible enough to warrant a permanent Codex-specific exclusion, or is it a model-version-specific symptom?
- Why did `project.md` alone reproduce a stall while `project.md + compound-lessons.md` succeeded in one probe? This suggests non-monotonic model behavior rather than a simple content threshold.
- Should Codex revision stop using a native grounding turn entirely and jump straight to a deterministic fallback strategy when the current plan already contains concrete file paths?
- Is there any revision-shaped native write prompt that is reliably streamable on this model, or is revision itself the unstable category once the task is "rewrite an existing plan" rather than "draft a new one"?

## Recommended Next Steps

If work resumes later, the best sequence is:

1. Keep using the harness, not Discord, until the full loop is stable.
2. Preserve the `plan-547` branch state and use it as the new baseline rather than continuing from older `plan-545` assumptions.
3. Focus the next pure-native investigation specifically on bounded revision grounding, not revision write, draft salvage, or CLI parsing.
4. Continue treating revision as two separate native risks: bounded grounding and final write. Do not assume fixing one fixes the other.
5. Stop assuming prompt summarization will recover native revision-write; the compact revision-write probe already stalled.
6. If pure-native revision remains a requirement, the next experiments should change task shape, not just prompt size: for example, "append targeted deltas" instead of "rewrite the full plan", or a turn that edits only named sections.
7. If reliability is the goal, prefer a flow change over more parser/transport work: keep pure-native investigation open, but route revision through deterministic salvage by design.
8. Keep treating later failures as phase-specific prompt/runtime issues rather than reopening the old draft transport theories by default.
9. After one more harness confirmation pass, run one real Discord `!forge` validation.

## Practical Lessons To Retain

### General forge-shaping lessons

- Separate discovery from final artifact writing whenever possible.
- Bounded candidate selection is more reliable than open-ended grounded discovery.
- Preserve raw traces. Several decisive findings only became obvious after comparing direct probes and harness traces side by side.
- Treat draft, audit, and revision as different turn shapes. Success on one phase does not prove the others are healthy.
- A long-running phase is not automatically wedged; instrument first and classify from real lifecycle data before assuming a transport failure.

### Codex-specific lessons

- Do not assume `tools: ['Read', 'Glob', 'Grep']` means Codex will actually behave like a typed file-tool runtime.
- For Codex, separate discovery from strict-output turns whenever possible.
- Native audit behavior is not a good proxy for native draft/revision behavior.
- When native Codex stalls on artifact writing, inspect the inherited context bundle before assuming the transport is broken.
- The newest hard problem is revision-specific: native revision grounding and revision-write can both no-text stall even after draft and audit improve.
- If a native forge retry occurs after a guarded grounding failure, do not trust same-thread retry reuse.
