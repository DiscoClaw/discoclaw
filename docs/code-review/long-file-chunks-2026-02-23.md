# Long File Chunk Audit Plan

- Timestamp (UTC): 2026-02-23T04:48:30.472Z
- Source review: docs/code-review/section-review-2026-02-23.json
- Source review timestamp (UTC): 2026-02-23T04:48:03.945Z
- Commit: 96b0edd
- Chunk size: 250
- Total chunks: 20

## Chunk Checklist

- [ ] discord | `src/discord/message-coordinator.ts` | chunk 1/12 | lines 1-250
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 2/12 | lines 251-500
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 3/12 | lines 501-750
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 4/12 | lines 751-1000
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 5/12 | lines 1001-1250
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 6/12 | lines 1251-1500
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 7/12 | lines 1501-1750
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 8/12 | lines 1751-2000
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 9/12 | lines 2001-2250
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 10/12 | lines 2251-2500
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 11/12 | lines 2501-2750
- [ ] discord | `src/discord/message-coordinator.ts` | chunk 12/12 | lines 2751-2771
- [ ] discord | `src/discord/plan-manager.ts` | chunk 1/8 | lines 1-250
- [ ] discord | `src/discord/plan-manager.ts` | chunk 2/8 | lines 251-500
- [ ] discord | `src/discord/plan-manager.ts` | chunk 3/8 | lines 501-750
- [ ] discord | `src/discord/plan-manager.ts` | chunk 4/8 | lines 751-1000
- [ ] discord | `src/discord/plan-manager.ts` | chunk 5/8 | lines 1001-1250
- [ ] discord | `src/discord/plan-manager.ts` | chunk 6/8 | lines 1251-1500
- [ ] discord | `src/discord/plan-manager.ts` | chunk 7/8 | lines 1501-1750
- [ ] discord | `src/discord/plan-manager.ts` | chunk 8/8 | lines 1751-1796

## Standard Review Focus

- Control flow and guard correctness.
- Error propagation, retries, and observability.
- Side-effect safety (I/O, network, subprocess, Discord mutations).
- Missing tests or weak assertions around changed behavior.

