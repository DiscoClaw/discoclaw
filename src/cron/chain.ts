// ---------------------------------------------------------------------------
// Cron chain: cycle detection and downstream job firing
// ---------------------------------------------------------------------------
// Enables multi-step pipelines where a completed job's persisted state is
// forwarded to its declared downstream jobs.  Keeps chain logic out of the
// executor, which only needs to call `fireDownstream` after a successful run.
// ---------------------------------------------------------------------------

import type { LoggerLike } from '../logging/logger-like.js';

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

/** Adjacency list: cronId → downstream cronIds. */
export type ChainGraph = Map<string, string[]>;

// ---------------------------------------------------------------------------
// Build graph from records
// ---------------------------------------------------------------------------

/**
 * Build a chain graph from an iterable of records that may declare downstream links.
 * Records without a `downstream` field (or with an empty array) are omitted.
 */
export function buildChainGraph(
  records: Iterable<{ cronId: string; downstream?: string[] }>,
): ChainGraph {
  const graph: ChainGraph = new Map();
  for (const rec of records) {
    if (rec.downstream && rec.downstream.length > 0) {
      graph.set(rec.cronId, [...rec.downstream]);
    }
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Cycle detection (DFS, three-color)
// ---------------------------------------------------------------------------

const WHITE = 0; // unvisited
const GRAY = 1;  // on the current DFS path
const BLACK = 2; // fully explored

/**
 * Detect all cycles in a chain graph.
 * Returns an array of cycles, where each cycle is the list of cronIds
 * forming the loop (first and last element are the same).
 * An empty array means the graph is acyclic.
 */
export function detectCycles(graph: ChainGraph): string[][] {
  const color = new Map<string, number>();
  const cycles: string[][] = [];
  const path: string[] = [];

  // Seed the color map with every node reachable from the graph.
  for (const [node, successors] of graph) {
    if (!color.has(node)) color.set(node, WHITE);
    for (const s of successors) {
      if (!color.has(s)) color.set(s, WHITE);
    }
  }

  function dfs(node: string): void {
    color.set(node, GRAY);
    path.push(node);

    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // Back-edge → extract the cycle from the current path.
        const start = path.indexOf(next);
        cycles.push([...path.slice(start), next]);
      } else if (c === WHITE) {
        dfs(next);
      }
    }

    path.pop();
    color.set(node, BLACK);
  }

  for (const [node] of color) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Check whether adding a directed edge `from → to` would introduce a cycle.
 * Returns `true` if a cycle would be formed; `false` otherwise.
 */
export function wouldCreateCycle(graph: ChainGraph, from: string, to: string): boolean {
  if (from === to) return true;

  // A cycle forms iff `from` is reachable from `to` in the existing graph.
  const visited = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === from) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Chain firing
// ---------------------------------------------------------------------------

export type ChainFireContext = {
  /** Look up a downstream job's record by cronId. */
  getRecord: (cronId: string) => { cronId: string; threadId: string } | undefined;
  /** Persist forwarded state onto a downstream job's record. */
  forwardState: (cronId: string, threadId: string, state: Record<string, unknown>) => Promise<void>;
  /** Trigger execution of a downstream job by cronId. */
  executeJob: (cronId: string) => Promise<void>;
  log?: LoggerLike;
};

/**
 * Fire the declared downstream jobs of a completed cron job.
 *
 * For each downstream cronId:
 *  1. Look up the downstream record.
 *  2. If the completed job produced non-empty state, forward it to the
 *     downstream record via the existing state persistence system.
 *  3. Trigger execution of the downstream job.
 *
 * Errors in individual downstream jobs do not prevent the remaining ones
 * from firing — each downstream is independent.
 *
 * @returns The list of downstream cronIds that were successfully executed.
 */
export async function fireDownstream(
  completedCronId: string,
  downstream: string[],
  state: Record<string, unknown> | undefined,
  ctx: ChainFireContext,
): Promise<string[]> {
  const fired: string[] = [];

  for (const downstreamId of downstream) {
    const record = ctx.getRecord(downstreamId);
    if (!record) {
      ctx.log?.warn(
        { cronId: completedCronId, downstream: downstreamId },
        'chain:downstream target record not found, skipping',
      );
      continue;
    }

    // Forward the completed job's state to the downstream job.
    if (state !== undefined && Object.keys(state).length > 0) {
      try {
        await ctx.forwardState(downstreamId, record.threadId, state);
        ctx.log?.info(
          { cronId: completedCronId, downstream: downstreamId },
          'chain:state forwarded',
        );
      } catch (err) {
        ctx.log?.warn(
          { err, cronId: completedCronId, downstream: downstreamId },
          'chain:state forward failed, executing without forwarded state',
        );
      }
    }

    // Trigger execution.
    try {
      await ctx.executeJob(downstreamId);
      fired.push(downstreamId);
      ctx.log?.info(
        { cronId: completedCronId, downstream: downstreamId },
        'chain:downstream fired',
      );
    } catch (err) {
      ctx.log?.warn(
        { err, cronId: completedCronId, downstream: downstreamId },
        'chain:downstream execution failed',
      );
    }
  }

  return fired;
}
