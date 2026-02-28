import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';
import type { RuntimeAdapter } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpawnActionRequest =
  | { type: 'spawnAgent'; prompt: string; label?: string };

const SPAWN_TYPE_MAP: Record<SpawnActionRequest['type'], true> = {
  spawnAgent: true,
};
export const SPAWN_ACTION_TYPES = new Set<string>(Object.keys(SPAWN_TYPE_MAP));

export type SpawnContext = {
  runtime: RuntimeAdapter;
  model: string;
  cwd: string;
  log?: LoggerLike;
  /** Recursion depth — 0 for user/cron origins, 1+ for action-triggered sub-invocations. */
  depth?: number;
  /** Max concurrent agents (default: 4). */
  maxConcurrent?: number;
  /** Timeout per agent invocation in ms (default: 120_000). */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Single executor
// ---------------------------------------------------------------------------

export async function executeSpawnAction(
  action: SpawnActionRequest,
  ctx: ActionContext,
  spawnCtx: SpawnContext,
): Promise<DiscordActionResult> {
  if ((spawnCtx.depth ?? 0) >= 1) {
    return { ok: false, error: 'spawnAgent blocked: recursion depth >= 1 (spawned agents cannot spawn further agents)' };
  }

  switch (action.type) {
    case 'spawnAgent': {
      if (!action.prompt?.trim()) {
        return { ok: false, error: 'spawnAgent requires a non-empty prompt' };
      }

      const label = action.label?.trim() || 'agent';
      const timeoutMs = spawnCtx.timeoutMs ?? 120_000;

      try {
        let text = '';
        const stream = spawnCtx.runtime.invoke({
          prompt: action.prompt,
          model: spawnCtx.model,
          cwd: spawnCtx.cwd,
          timeoutMs,
        });

        for await (const event of stream) {
          if (event.type === 'text_delta') {
            text += event.text;
          } else if (event.type === 'text_final') {
            text = event.text;
          } else if (event.type === 'error') {
            return { ok: false, error: `spawnAgent (${label}) failed: ${event.message}` };
          }
        }

        const trimmed = text.trim();
        return {
          ok: true,
          summary: trimmed || `Agent (${label}) completed with no output.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `spawnAgent (${label}) failed: ${msg}` };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parallel coordinator
// ---------------------------------------------------------------------------

/**
 * Execute multiple spawnAgent actions in parallel, bounded by maxConcurrent.
 * Results are returned in the same order as the input actions.
 */
export async function executeSpawnActions(
  actions: SpawnActionRequest[],
  ctx: ActionContext,
  spawnCtx: SpawnContext,
): Promise<DiscordActionResult[]> {
  if (actions.length === 0) return [];

  const maxConcurrent = spawnCtx.maxConcurrent ?? 4;
  const results: DiscordActionResult[] = new Array(actions.length);

  let i = 0;
  while (i < actions.length) {
    const batch = actions.slice(i, i + maxConcurrent);
    const settled = await Promise.allSettled(
      batch.map((action) => executeSpawnAction(action, ctx, spawnCtx)),
    );
    for (let j = 0; j < settled.length; j++) {
      const item = settled[j]!;
      results[i + j] = item.status === 'fulfilled'
        ? item.value
        : { ok: false, error: item.reason instanceof Error ? item.reason.message : String(item.reason) };
    }
    i += maxConcurrent;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function spawnActionsPromptSection(): string {
  return `### Spawn Agent

**spawnAgent** — Spawn a sub-agent with a prompt and receive its output:
\`\`\`
<discord-action>{"type":"spawnAgent","prompt":"List all open tasks and summarize their status","label":"task-summary"}</discord-action>
\`\`\`
- \`prompt\` (required): The instruction to send to the sub-agent.
- \`label\` (optional): A short human-readable label for the agent (used in error messages).

#### Spawn Guidelines
- Multiple spawnAgent actions in a single response are run in parallel for efficiency.
- Spawned agents run at recursion depth 1 and cannot themselves spawn further agents.
- Agent output is returned to you as an action result for further analysis.
- Keep prompts focused — each agent handles a single well-defined task.`;
}
