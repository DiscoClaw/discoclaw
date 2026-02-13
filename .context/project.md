# Project Context — Discoclaw

Standing constraints for planning and auditing. These apply to all forge/plan operations.

## Architecture

- Single-user system (one Discord bot, one human operator). No concurrent access guards needed.
- Phase runner already has its own writer lock — don't design new locking mechanisms.
- No cancellation/abort support required beyond what already exists.

## Stack

- TypeScript, Node >=20, pnpm
- Vitest for tests
- Plans stored in workspace/plans/

## Conventions

- Keep changes minimal — don't over-engineer for hypothetical multi-user scenarios.
- Prefer wiring existing systems together over building new abstractions.
- Tests are required for new functionality.