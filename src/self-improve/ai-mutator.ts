// ── AI-guided mutator ───────────────────────────────────────────────
//
// Uses an LLM to propose targeted instruction edits based on scoring
// results. Unlike the random/structural mutator, this can ADD new
// instructions, rewrite unclear rules, and fix specific failures.
//
// The AI mutator is optional — when no API key is available or the
// call fails, the harness falls back to structural mutations.

import type { ScoreResult, Mutation, MutationOp } from './types.js';

// ── Types ───────────────────────────────────────────────────────────

export interface AiMutatorOpts {
  /** Anthropic API key for the mutation-proposing LLM. */
  apiKey: string;
  /** Model to use for mutation proposals. Defaults to claude-sonnet-4-20250514. */
  model?: string;
  /** Base URL for the API. Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  /** Maximum tokens for the LLM response. Defaults to 2048. */
  maxTokens?: number;
  /** Timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  log?: { debug(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export interface AiMutationProposal {
  /** Human-readable description of the proposed change. */
  description: string;
  /** The mutation operations to apply. */
  ops: MutationOp[];
  /** The LLM's reasoning for this change. */
  reasoning: string;
}

// ── Prompt construction ─────────────────────────────────────────────

function buildFailureSummary(results: ScoreResult[]): string {
  const failures = results.filter((r) => r.score < 1.0);
  if (failures.length === 0) return 'All test cases passed with perfect scores.';

  const lines: string[] = [];
  for (const f of failures) {
    const parts: string[] = [`- ${f.testCaseId}: score ${f.score.toFixed(3)}`];

    // Detail unmatched expected actions
    const unmatched = f.matches.filter((m) => m.score === 0);
    if (unmatched.length > 0) {
      parts.push(`  Missing actions: ${unmatched.map((m) => m.expected.type).join(', ')}`);
    }

    // Detail partial matches
    const partial = f.matches.filter((m) => m.score > 0 && m.score < 1);
    if (partial.length > 0) {
      parts.push(`  Partial matches: ${partial.map((m) => `${m.expected.type} (${m.score.toFixed(2)})`).join(', ')}`);
    }

    // Detail violations
    if (f.violations.length > 0) {
      parts.push(`  Violations: ${f.violations.map((v) => `emitted forbidden ${v.forbiddenType}`).join(', ')}`);
    }

    lines.push(parts.join('\n'));
  }

  return `${failures.length} test case(s) scored below 1.0:\n${lines.join('\n')}`;
}

function buildMutationPrompt(
  instructions: string,
  results: ScoreResult[],
  meanScore: number,
): string {
  const failureSummary = buildFailureSummary(results);
  const lineCount = instructions.split('\n').length;

  return `You are an instruction-optimization assistant. Your job is to propose a single, targeted edit to a set of AI instructions to improve compliance scores on a test suite.

## Current Score
Mean score: ${meanScore.toFixed(3)} (1.000 = perfect)

## Test Results
${failureSummary}

## Current Instructions (${lineCount} lines)
\`\`\`
${instructions}
\`\`\`

## Your Task
Propose ONE targeted edit to the instructions that would fix the highest-impact failure(s). The edit should:
1. Be minimal — change as few lines as possible
2. Not break existing passing test cases
3. Be specific and concrete — not vague rewording

## Response Format
Respond with ONLY a JSON object (no markdown fencing, no explanation outside the JSON):
{
  "reasoning": "Brief explanation of why this change should help",
  "description": "Human-readable description of the edit",
  "ops": [
    {
      "kind": "insert" | "delete" | "replace",
      "target": <zero-based line number>,
      "content": "<new line content, required for insert/replace>"
    }
  ]
}

Rules for ops:
- "target" is a zero-based line index in the current instructions
- "insert" adds a new line BEFORE the target line (target can be 0 to ${lineCount})
- "delete" removes the line at target (0 to ${lineCount - 1})
- "replace" replaces the line at target with content (0 to ${lineCount - 1})
- Apply ops in sequence — later ops see the result of earlier ones
- Keep it to 1-5 ops maximum`;
}

// ── LLM call ────────────────────────────────────────────────────────

async function callLlm(
  prompt: string,
  opts: AiMutatorOpts,
): Promise<string> {
  const model = opts.model ?? 'claude-sonnet-4-20250514';
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  const maxTokens = opts.maxTokens ?? 2048;
  const timeoutMs = opts.timeoutMs ?? 30000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        detail = errBody.error?.message ?? '';
      } catch { /* ignore */ }
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
    }

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const textBlock = body.content?.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      throw new Error('No text content in LLM response');
    }

    return textBlock.text;
  } finally {
    clearTimeout(timer);
  }
}

// ── Response parsing ────────────────────────────────────────────────

const VALID_KINDS = new Set(['insert', 'delete', 'replace', 'swap']);

function parseProposal(raw: string, lineCount: number): AiMutationProposal {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  const parsed = JSON.parse(cleaned) as {
    reasoning?: string;
    description?: string;
    ops?: Array<{
      kind?: string;
      target?: number;
      content?: string;
      swapWith?: number;
    }>;
  };

  if (!parsed.ops || !Array.isArray(parsed.ops) || parsed.ops.length === 0) {
    throw new Error('LLM response missing "ops" array');
  }

  if (parsed.ops.length > 10) {
    throw new Error(`LLM proposed ${parsed.ops.length} ops — max is 10`);
  }

  const ops: MutationOp[] = [];
  for (const op of parsed.ops) {
    if (!op.kind || !VALID_KINDS.has(op.kind)) {
      throw new Error(`Invalid op kind: ${op.kind}`);
    }
    if (typeof op.target !== 'number' || op.target < 0) {
      throw new Error(`Invalid op target: ${op.target}`);
    }
    if ((op.kind === 'insert' || op.kind === 'replace') && typeof op.content !== 'string') {
      throw new Error(`${op.kind} op requires "content" string`);
    }

    ops.push({
      kind: op.kind as MutationOp['kind'],
      target: op.target,
      ...(op.content !== undefined ? { content: op.content } : {}),
      ...(op.swapWith !== undefined ? { swapWith: op.swapWith } : {}),
    });
  }

  return {
    description: parsed.description ?? 'AI-guided mutation',
    reasoning: parsed.reasoning ?? '',
    ops,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Generate an AI-guided mutation based on scoring results.
 *
 * Calls an LLM to analyse failures and propose a targeted instruction edit.
 * Returns null if the LLM call fails or produces an unparseable response.
 */
export async function generateAiMutation(
  instructions: string,
  results: ScoreResult[],
  meanScore: number,
  opts: AiMutatorOpts,
): Promise<Mutation | null> {
  try {
    const prompt = buildMutationPrompt(instructions, results, meanScore);
    opts.log?.debug('ai-mutator: calling LLM for mutation proposal');

    const raw = await callLlm(prompt, opts);
    const lineCount = instructions.split('\n').length;
    const proposal = parseProposal(raw, lineCount);

    opts.log?.debug(
      { description: proposal.description, reasoning: proposal.reasoning, opCount: proposal.ops.length },
      'ai-mutator: proposal parsed',
    );

    return {
      ops: proposal.ops,
      description: `[AI] ${proposal.description}`,
    };
  } catch (err) {
    opts.log?.warn({ err: String(err) }, 'ai-mutator: failed, will fall back to structural mutation');
    return null;
  }
}

// Re-export for testing
export { buildFailureSummary, buildMutationPrompt, parseProposal };
