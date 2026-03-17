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

// ── Structural analysis ───────────────────────────────────────────

/** A contiguous section of instruction text delimited by markdown headings. */
export interface Section {
  /** Zero-based line index of the heading. */
  start: number;
  /** Zero-based line index one past the last line of the section. */
  end: number;
  /** The heading text (including # prefix). */
  heading: string;
  /** Heading depth (number of # characters). */
  depth: number;
}

/** A bullet list item with its line index. */
export interface BulletItem {
  /** Zero-based line index. */
  line: number;
  /** The full line text. */
  text: string;
}

/** Structural analysis result for instruction text. */
export interface TextStructure {
  sections: Section[];
  bullets: BulletItem[];
  lineCount: number;
}

const HEADING_RE = /^(#{1,6})\s+/;
const BULLET_RE = /^(\s*[-*+]|\s*\d+\.)\s+/;

/**
 * Analyse instruction text and identify structural elements:
 * sections (delimited by headings) and bullet items.
 */
export function analyseStructure(text: string): TextStructure {
  const lines = text.split('\n');
  const n = lines.length;
  const sections: Section[] = [];
  const bullets: BulletItem[] = [];

  // Identify headings and bullets.
  const headingLines: { line: number; depth: number; text: string }[] = [];
  for (let i = 0; i < n; i++) {
    const hm = HEADING_RE.exec(lines[i]);
    if (hm) {
      headingLines.push({ line: i, depth: hm[1].length, text: lines[i] });
    }
    if (BULLET_RE.test(lines[i])) {
      bullets.push({ line: i, text: lines[i] });
    }
  }

  // Build sections from heading positions.
  for (let i = 0; i < headingLines.length; i++) {
    const start = headingLines[i].line;
    const end = i + 1 < headingLines.length ? headingLines[i + 1].line : n;
    sections.push({
      start,
      end,
      heading: headingLines[i].text,
      depth: headingLines[i].depth,
    });
  }

  return { sections, bullets, lineCount: n };
}

// ── Targeted mutation strategies ──────────────────────────────────

type TargetedStrategy = (structure: TextStructure, lines: string[], rng: () => number) => Mutation | null;

/**
 * Remove an entire section (heading + body).
 * Tests whether a whole section is load-bearing.
 */
const removeSection: TargetedStrategy = (structure, _lines, rng) => {
  const { sections } = structure;
  if (sections.length === 0) return null;
  const idx = Math.floor(rng() * sections.length);
  const sec = sections[idx];
  const ops: MutationOp[] = [];
  // Delete from end to start so indices stay valid.
  for (let i = sec.end - 1; i >= sec.start; i--) {
    ops.push({ kind: 'delete', target: i });
  }
  return { ops, description: `remove section "${sec.heading.trim()}" (lines ${sec.start}–${sec.end - 1})` };
};

/**
 * Swap two sections (reorder entire blocks).
 * Tests whether section ordering matters.
 */
const swapSections: TargetedStrategy = (structure, lines, rng) => {
  const { sections } = structure;
  if (sections.length < 2) return null;
  const a = Math.floor(rng() * sections.length);
  let b = Math.floor(rng() * (sections.length - 1));
  if (b >= a) b++;
  const secA = sections[a];
  const secB = sections[b];
  // Swap by replacing both sections' line ranges.
  // Extract the text blocks, then rebuild via replace ops.
  const linesA = lines.slice(secA.start, secA.end);
  const linesB = lines.slice(secB.start, secB.end);

  // Work from the later section first so indices remain valid.
  const [first, second] = secA.start < secB.start ? [secA, secB] : [secB, secA];
  const [firstLines, secondLines] = secA.start < secB.start ? [linesA, linesB] : [linesB, linesA];
  const [replaceFirst, replaceSecond] = secA.start < secB.start ? [linesB, linesA] : [linesA, linesB];

  const ops: MutationOp[] = [];

  // Delete second section (back to front), then insert replacement.
  for (let i = second.end - 1; i >= second.start; i--) {
    ops.push({ kind: 'delete', target: i });
  }
  for (let i = 0; i < replaceSecond.length; i++) {
    ops.push({ kind: 'insert', target: second.start + i, content: replaceSecond[i] });
  }

  // Delete first section (back to front), then insert replacement.
  for (let i = first.end - 1; i >= first.start; i--) {
    ops.push({ kind: 'delete', target: i });
  }
  for (let i = 0; i < replaceFirst.length; i++) {
    ops.push({ kind: 'insert', target: first.start + i, content: replaceFirst[i] });
  }

  return {
    ops,
    description: `swap sections "${secA.heading.trim()}" and "${secB.heading.trim()}"`,
  };
};

/**
 * Remove a single bullet item.
 * Tests whether individual rules/items are necessary.
 */
const removeBullet: TargetedStrategy = (structure, _lines, rng) => {
  const { bullets } = structure;
  if (bullets.length === 0) return null;
  const idx = Math.floor(rng() * bullets.length);
  const bullet = bullets[idx];
  return {
    ops: [{ kind: 'delete', target: bullet.line }],
    description: `remove bullet at line ${bullet.line}: "${bullet.text.trim().slice(0, 60)}"`,
  };
};

/**
 * Weaken a strong directive by replacing imperative keywords.
 * Tests whether strong phrasing affects compliance.
 */
const weakenDirective: TargetedStrategy = (structure, lines, rng) => {
  // Find lines containing strong directives.
  const strongPatterns = [
    { re: /\bMUST\b/, replacement: 'SHOULD' },
    { re: /\bNEVER\b/, replacement: 'AVOID' },
    { re: /\bALWAYS\b/, replacement: 'USUALLY' },
    { re: /\bREQUIRED\b/i, replacement: 'recommended' },
    { re: /\bDO NOT\b/i, replacement: 'Try not to' },
  ];

  const candidates: { line: number; patIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let p = 0; p < strongPatterns.length; p++) {
      if (strongPatterns[p].re.test(lines[i])) {
        candidates.push({ line: i, patIdx: p });
      }
    }
  }
  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(rng() * candidates.length)];
  const pat = strongPatterns[pick.patIdx];
  const newContent = lines[pick.line].replace(pat.re, pat.replacement);

  return {
    ops: [{ kind: 'replace', target: pick.line, content: newContent }],
    description: `weaken directive at line ${pick.line}: ${pat.re.source} → ${pat.replacement}`,
  };
};

/**
 * Duplicate a bullet item (tests whether redundancy helps or hurts).
 */
const duplicateBullet: TargetedStrategy = (structure, lines, rng) => {
  const { bullets } = structure;
  if (bullets.length === 0) return null;
  const idx = Math.floor(rng() * bullets.length);
  const bullet = bullets[idx];
  return {
    ops: [{ kind: 'insert', target: bullet.line + 1, content: lines[bullet.line] }],
    description: `duplicate bullet at line ${bullet.line}: "${bullet.text.trim().slice(0, 60)}"`,
  };
};

const TARGETED_STRATEGIES: TargetedStrategy[] = [
  removeSection,
  swapSections,
  removeBullet,
  weakenDirective,
  duplicateBullet,
];

/**
 * Generate targeted mutations based on structural analysis of instruction text.
 *
 * Unlike `generateRandomMutation` which picks random lines, this analyses
 * the markdown structure (sections, bullets, directives) and produces
 * mutations that test specific structural hypotheses.
 *
 * Returns an array of mutations — one per applicable strategy. Strategies
 * that can't produce a mutation for the given text are skipped.
 *
 * Accepts an optional RNG for deterministic testing.
 */
export function generateTargetedMutations(
  text: string,
  rng: () => number = Math.random,
): Mutation[] {
  const lines = text.split('\n');

  // Degenerate case — can't do structural analysis on empty text.
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return [];
  }

  const structure = analyseStructure(text);
  const mutations: Mutation[] = [];

  for (const strategy of TARGETED_STRATEGIES) {
    const mutation = strategy(structure, lines, rng);
    if (mutation && mutation.ops.length > 0) {
      mutations.push(mutation);
    }
  }

  return mutations;
}

/**
 * Pick one targeted mutation at random from available strategies.
 * Falls back to `generateRandomMutation` if no targeted strategies apply.
 */
export function generateMutation(
  text: string,
  rng: () => number = Math.random,
): Mutation {
  const targeted = generateTargetedMutations(text, rng);
  if (targeted.length > 0) {
    return targeted[Math.floor(rng() * targeted.length)];
  }
  return generateRandomMutation(text, rng);
}
