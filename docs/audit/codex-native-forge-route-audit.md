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
   - bounded native grounding can now work
   - native audit turns generally stream and complete
   - the main failure narrowed to draft/revision write-turn behavior

4. The strongest remaining native write-turn trigger was prompt context shape.
   - native draft-write worked with no extra context
   - native draft-write also worked with a reduced workspace identity context bundle
   - native draft-write repeatedly stalled when it inherited workspace `AGENTS.md`
   - repo `project.md` alone also reproduced a stall in direct probes
   - the effect was not purely size-based; it was prompt-shape sensitive and somewhat model-sensitive

Current status at the end of this pass:

- Native draft grounding is materially improved.
- Native draft-write was reproduced working after filtering the native write context.
- In the latest harness run, native draft completed and forge advanced into native audit.
- The remaining open question is end-to-end reliability across later rounds, not the old draft-write no-text stall.

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

## Current Local Patch State

As of this memo, the latest local code work is in:

- [src/discord/forge-commands.ts](/home/davidmarsh/code/discoclaw/src/discord/forge-commands.ts)
- [src/discord/forge-commands.test.ts](/home/davidmarsh/code/discoclaw/src/discord/forge-commands.test.ts)

The key local change is:

- native Codex draft/revision write turns now use a filtered context bundle built from workspace `SOUL.md`, `IDENTITY.md`, `USER.md`, and `TOOLS.md`
- that filtered bundle intentionally excludes:
  - workspace `AGENTS.md`
  - repo `project.md`
  - repo `compound-lessons.md`

The reason for that filter is empirical:

- that reduced context bundle reproduced native write success in direct probes
- the broader inherited context bundle repeatedly reproduced the native no-text stall

Verification completed for the local patch:

- `pnpm exec vitest run src/discord/forge-commands.test.ts`
- `pnpm build`

## Remaining Open Questions

The investigation is narrower now, but not finished.

Open questions:

- Does forge now complete full end-to-end on the native path through later audit/revision rounds with the filtered write context?
- Is the toxic effect of `AGENTS.md` stable and reproducible enough to warrant a permanent Codex-specific exclusion, or is it a model-version-specific symptom?
- Why did `project.md` alone reproduce a stall while `project.md + compound-lessons.md` succeeded in one probe? This suggests non-monotonic model behavior rather than a simple content threshold.
- Should native revision-write use the same filtered context as draft-write permanently, or should revision be even smaller?

## Recommended Next Steps

If work resumes later, the best sequence is:

1. Keep using the harness, not Discord, until the full loop is stable.
2. Re-run the latest local patch with `pnpm forge:repro -- --from-plan plan-502 --trace-notifications`.
3. Validate whether the forge now completes past audit and revision on the native path.
4. If later phases still fail, treat them as new prompt-shape issues rather than reopening the old transport theories by default.
5. Only after a harness end-to-end success, run one real Discord `!forge` validation.

## Practical Lessons To Retain

- Do not assume `tools: ['Read', 'Glob', 'Grep']` means Codex will actually behave like a typed file-tool runtime.
- For Codex, separate discovery from strict-output turns whenever possible.
- Bounded candidate selection is far more reliable than open-ended grounded discovery.
- Native audit behavior is not a good proxy for native draft/revision behavior.
- When native Codex stalls on artifact writing, inspect the inherited context bundle before assuming the transport is broken.
- If a native forge retry occurs after a guarded grounding failure, do not trust same-thread retry reuse.
- Preserve raw traces. Several decisive findings only became obvious after comparing direct probes and harness traces side by side.

