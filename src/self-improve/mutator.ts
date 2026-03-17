// ── Instruction mutator ─────────────────────────────────────────────
//
// Applies line-level mutations to instruction text (markdown).
// Each MutationOp targets a zero-based line index.
// Operations are applied in sequence, so later ops see the result of earlier ones.

import type { Mutation, MutationKind, MutationOp, MutationResult } from './types.js';

// ── Errors ──────────────────────────────────────────────────────────

export class MutationError extends Error {
  constructor(
    message: string,
    public readonly op: MutationOp,
    public readonly lineCount: number,
  ) {
    super(message);
    this.name = 'MutationError';
  }
}

// ── Single-op application ───────────────────────────────────────────

function assertInRange(op: MutationOp, lineCount: number, label: string, index: number): void {
  if (index < 0 || index >= lineCount) {
    throw new MutationError(
      `${label} index ${index} out of range (0–${lineCount - 1})`,
      op,
      lineCount,
    );
  }
}

function applyOp(lines: string[], op: MutationOp): string[] {
  const out = [...lines];

  switch (op.kind) {
    case 'insert': {
      if (op.content === undefined) {
        throw new MutationError('insert op requires "content"', op, out.length);
      }
      // Insert allowed at [0, lines.length] — inserting after the last line is valid
      if (op.target < 0 || op.target > out.length) {
        throw new MutationError(
          `insert target ${op.target} out of range (0–${out.length})`,
          op,
          out.length,
        );
      }
      out.splice(op.target, 0, op.content);
      break;
    }

    case 'delete': {
      assertInRange(op, out.length, 'delete target', op.target);
      out.splice(op.target, 1);
      break;
    }

    case 'replace': {
      if (op.content === undefined) {
        throw new MutationError('replace op requires "content"', op, out.length);
      }
      assertInRange(op, out.length, 'replace target', op.target);
      out[op.target] = op.content;
      break;
    }

    case 'swap': {
      if (op.swapWith === undefined) {
        throw new MutationError('swap op requires "swapWith"', op, out.length);
      }
      assertInRange(op, out.length, 'swap target', op.target);
      assertInRange(op, out.length, 'swap swapWith', op.swapWith);
      const tmp = out[op.target];
      out[op.target] = out[op.swapWith];
      out[op.swapWith] = tmp;
      break;
    }

    default: {
      const _exhaustive: never = op.kind;
      throw new MutationError(`Unknown mutation kind: ${_exhaustive}`, op, out.length);
    }
  }

  return out;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Apply a sequence of mutation operations to instruction text.
 * Operations are applied in order; each sees the result of previous ops.
 * Returns the original text, mutated text, and the mutation descriptor.
 */
export function applyMutation(text: string, mutation: Mutation): MutationResult {
  let lines = text.split('\n');

  for (const op of mutation.ops) {
    lines = applyOp(lines, op);
  }

  return {
    original: text,
    mutated: lines.join('\n'),
    mutation,
  };
}

/**
 * Build a single-op mutation for convenience.
 */
export function singleOp(op: MutationOp, description?: string): Mutation {
  return {
    ops: [op],
    description: description ?? `${op.kind} at line ${op.target}`,
  };
}

/**
 * Generate a random single-op mutation for the given instruction text.
 *
 * Picks from safe, content-preserving operations:
 *   - `swap`   (reorder two lines — no information loss)
 *   - `delete` (remove one line)
 *
 * Accepts an optional RNG function (returns values in [0, 1)) for
 * deterministic testing.
 */
export function generateRandomMutation(
  text: string,
  rng: () => number = Math.random,
): Mutation {
  const lines = text.split('\n');
  const n = lines.length;

  // Degenerate case: empty or single-empty-line text — insert so the op is valid.
  if (n === 0 || (n === 1 && lines[0] === '')) {
    return {
      ops: [{ kind: 'insert', target: 0, content: '' }],
      description: 'insert line into empty text',
    };
  }

  // Build available mutation kinds based on line count.
  const kinds: MutationKind[] = ['delete'];
  if (n >= 2) kinds.push('swap');

  const kind = kinds[Math.floor(rng() * kinds.length)];

  switch (kind) {
    case 'swap': {
      const a = Math.floor(rng() * n);
      // Pick b ≠ a by drawing from [0, n-1) then skipping past a.
      let b = Math.floor(rng() * (n - 1));
      if (b >= a) b++;
      return {
        ops: [{ kind: 'swap', target: a, swapWith: b }],
        description: `swap lines ${a} and ${b}`,
      };
    }
    case 'delete':
    default: {
      const target = Math.floor(rng() * n);
      return {
        ops: [{ kind: 'delete', target }],
        description: `delete line ${target}`,
      };
    }
  }
}
