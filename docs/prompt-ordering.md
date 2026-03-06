# Prompt Section Ordering

How DiscoClaw assembles prompts to exploit primacy bias, recency bias, and minimize the "dumb zone" in the middle of long prompts.

## Attention Zones

LLMs allocate attention unevenly across long prompts. Research consistently shows:

- **Primacy zone** (front): high compliance — instructions here are followed most reliably
- **Middle zone** ("dumb zone"): lowest compliance — model attention drops in the center of long prompts
- **Recency zone** (near user message): high compliance — recency bias boosts the last sections before the response

DiscoClaw's prompt assembly exploits this by placing critical sections in primacy and recency positions, and relegating low-signal ambient data to the middle.

## Prompt Structure

### Preamble (immutable precedence contract)

The preamble is assembled by `buildPromptPreamble()` in `src/discord/prompt-common.ts`. Its ordering is fixed and governs security layering:

| Position | Section | Purpose |
|----------|---------|---------|
| 1 | `ROOT_POLICY` | Immutable injection-defence rules (5 rules, ~133 tokens) |
| 2 | `TRACKED_DEFAULTS` | System defaults from `templates/instructions/SYSTEM_DEFAULTS.md` |
| 3 | `TRACKED_TOOLS` | Tool and environment guidance from `templates/instructions/TOOLS.md` |
| 4 | Inlined context | SOUL + IDENTITY + USER + AGENTS + optional workspace `TOOLS.md` overlay + pa.md + channel context |

This contract is **not** subject to reordering. It is preserved exactly as defined in `CLAUDE.md`.

### Post-preamble sections (zone-optimized)

After the preamble, sections are ordered by attention zone using the `SECTION_ZONE_MAP` in `prompt-common.ts`:

| Zone | Section key | Order | Content | Signal level |
|------|-------------|------:|---------|-------------|
| **primacy** | `task` | 0 | Task thread context (ID, status, description) | High — thread-specific |
| **primacy** | `durableMemory` | 1 | User-specific facts/preferences (Hebbian-scored) | High — personalization |
| **primacy** | `coldStorage` | 2 | Semantic search results from conversation history | High — contextual recall |
| **middle** | `shortTermMemory` | 0 | Cross-channel activity snippets | Low — ambient awareness |
| **middle** | `openTasks` | 1 | Open tasks summary (max 600 chars) | Low — background reference |
| **middle** | `startup` | 2 | One-shot startup injection (cleared after use) | Low — ephemeral |
| **recency** | `rollingSummary` | 0 | Compressed conversation history | High — continuity |
| **recency** | `history` | 1 | Recent message history (budget-based) | High — conversational |
| **recency** | `replyRef` | 2 | Replied-to message content + images | High — direct context |
| **recency** | `actionsReference` | 3 | Discord action schemas (tiered) | Critical — tool compliance |

### Post-section tail

After the ordered sections, the prompt appends:

| Position | Content | Purpose |
|----------|---------|---------|
| A | Permission/capability notes | Runtime tool filtering notes |
| B | Internal context separator | "Sections above are internal system context..." |
| C | **User message** | The actual user input — absolute last position |
| D | Text attachments | Attached file contents (if any) |

The user message at position C exploits maximum recency bias. Text attachments at D are data, not instructions.

## Rationale

### Why actionsReference is in the recency zone

Action schemas are the most compliance-sensitive section. Without them, the AI cannot emit structured `<discord-action>` blocks correctly. Placing them in the recency zone (just before the separator and user message) ensures:

1. The AI has the schema format fresh when generating its response
2. Tiered action loading (core + contextual + keyword-triggered) means only relevant schemas are present
3. The schemas are not buried in the middle where compliance drops

### Why durable memory is in the primacy zone

Durable memory contains user-specific facts ("I prefer dark roast coffee", "my timezone is US/Pacific"). These facts should color the entire response, not just be recalled when explicitly relevant. Primacy placement ensures the AI's "world model" for the response includes these facts from the start.

### Why cold storage is in the primacy zone

Cold-storage search results are semantically retrieved context from past conversations — they represent the most relevant historical information for the current query. Like durable memory, these facts should inform the entire response. Primacy placement (order 2, after durable memory) ensures the AI incorporates retrieved context as foundational background rather than treating it as incidental detail.

### Why conversation state is in the recency zone

Rolling summary and message history provide the conversational context the AI needs to generate a coherent reply. Placing these near the user message means the AI processes them immediately before responding, reducing the chance of "forgetting" recent conversation topics.

### Why low-signal sections are in the middle

Short-term memory (cross-channel snippets), open tasks summaries, and startup context are useful but not critical for most responses. They provide ambient awareness without needing high compliance. If the model partially ignores them, the response quality is minimally affected.

## Implementation

### Infrastructure (`src/discord/prompt-common.ts`)

- `PromptZone` type: `'primacy' | 'middle' | 'recency'`
- `OrderedPromptSection` interface: `{ key, zone, label?, content }`
- `SECTION_ZONE_MAP`: canonical zone/order assignments
- `orderPostPreambleSections()`: sorts sections by zone priority, then intra-zone order
- `formatOrderedSection()`: renders `---` separator + optional label + content
- `assemblePostPreambleSections()`: filters empties, sorts, joins

### Assembly (`src/discord/message-coordinator.ts`)

The message handler builds sections with zone assignments from `SECTION_ZONE_MAP`, then assembles them in zone order. The current implementation uses inline string concatenation that follows the zone ordering defined in `SECTION_ZONE_MAP`.

### Other prompt flows

The reaction handler (`src/discord/reaction-handler.ts`), deferred runner (`src/discord/deferred-runner.ts`), and voice prompt builder (`src/voice/voice-prompt-builder.ts`) use simplified prompt assembly. They follow the same preamble contract but may not use the full zone-based ordering (fewer sections to order).

## Diagnostics

Section token estimates are logged at prompt assembly time via the `message:prompt:section-estimates` log event. Each section reports `chars` and `estTokens` (`ceil(chars/4)`). See `docs/prompt-token-audit.md` for the full token budget analysis.

## Modifying the ordering

To change a section's zone or intra-zone position:

1. Update `SECTION_ZONE_MAP` in `src/discord/prompt-common.ts`
2. Run tests: `pnpm test` (zone ordering tests in `prompt-common.test.ts`)
3. Verify with a test invocation and check `message:prompt:section-estimates` logs

To add a new section:

1. Add the key to `SECTION_ZONE_MAP` with a zone and order value
2. Add the key to `PromptSectionKey` type (if it should appear in token estimates)
3. Build the section content in the message coordinator
4. Add an `OrderedPromptSection` entry in the assembly block
