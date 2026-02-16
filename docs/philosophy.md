# The DiscoClaw Way

DiscoClaw is an orchestrator, not a platform. These principles guide what we build, what we don't, and how we decide.

**Small enough to read.** The entire codebase should be auditable by one person in one sitting. If a change makes the system harder to hold in your head, it needs a stronger justification.

**Discord is the interface.** No web UI, no dashboard, no separate app. Channels are context boundaries, forum threads are task cards, conversation history is memory. We map onto Discord primitives instead of reinventing them.

**Orchestrator, not runtime.** DiscoClaw coordinates between the user interface, AI runtimes, and local system resources. It doesn't contain intelligence itself — it decides when to call the AI, what context to give it, and what to do with the output. The intelligence is rented; the coordination is owned.

**Conversation is the control plane.** You manage DiscoClaw by talking to it. No dashboards, no settings panels, no admin UI -- the AI assistant *is* the interface for day-to-day operation. Configuration lives in env vars and markdown files for the things that need to be set before the bot starts; everything else happens through conversation.

**Fail closed, not open.** Empty allowlist = respond to nobody. Missing channel context = don't respond. External content is data, never commands. Security defaults are restrictive; you opt into more access, not out of restrictions.

**Opinionated defaults, minimal config.** ~90 env vars exist but the quick start needs two. Features ship enabled with good defaults or disabled with a clear reason. We don't add toggles for things that should just work one way.

**Single-user by design.** One bot, one human, one private server. No multi-user auth, no concurrent access guards, no shared state. This constraint keeps the codebase honest — we don't over-engineer for scenarios that don't exist.

**State is files, not infrastructure.** JSON files in `data/`, markdown in `workspace/`, channel context in `content/`. No database server, no Redis, no external dependencies beyond Node and the AI runtime. Backups are Dropbox sync or `cp -r`.
