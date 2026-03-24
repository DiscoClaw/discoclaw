/**
 * Dynamic section trimming tests — verify that on follow-up turns within an
 * active session, dynamic prompt sections can be conditionally excluded or
 * reduced to save tokens.
 *
 * Strategy: on follow-ups, channel context is excluded from `contextFiles`
 * fed into `buildPromptPreamble()`, and conversation history is trimmed to
 * only new messages in the post-preamble zones.
 *
 * These tests exercise:
 * - `buildPreambleContextFiles` excludes channel context (preamble-level trimming)
 * - `buildContextFiles` includes channel context (first-turn baseline)
 * - `orderPostPreambleSections` / `assemblePostPreambleSections` handle
 *   empty sections gracefully (dynamic sections trimmed to empty)
 * - `buildPromptSectionEstimates` reflects reduced sizes after trimming
 * - Token estimation reflects char savings
 */

import { describe, expect, it } from 'vitest';

import {
  buildContextFiles,
  buildPreambleContextFiles,
  buildPromptPreamble,
  buildPromptSectionEstimates,
  estimateTokensFromChars,
  orderPostPreambleSections,
  assemblePostPreambleSections,
  formatOrderedSection,
  getSectionZoneMap,
} from '../../src/discord/prompt-common.js';
import type { OrderedPromptSection, InlinedContextSection } from '../../src/discord/prompt-common.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDcc(paContextFiles: string[] = []) {
  return {
    contentDir: '/content',
    indexPath: '/content/index.md',
    paContextFiles,
    channelsDir: '/content/discord',
    byChannelId: new Map(),
    dmContextPath: '/content/discord/dm.md',
  };
}

function makeSection(key: string, content: string, zone: 'primacy' | 'middle' | 'recency', label?: string): OrderedPromptSection {
  return { key, zone, content, label };
}

function makeInlinedSection(filePath: string, rendered: string): InlinedContextSection {
  const fileName = filePath.split('/').pop() ?? filePath;
  return { filePath, fileName, rendered, chars: rendered.length };
}

// ---------------------------------------------------------------------------
// 1. Channel context exclusion from preamble (first-turn vs follow-up)
// ---------------------------------------------------------------------------

describe('channel context exclusion from preamble files', () => {
  const paFiles = ['/workspace/SOUL.md', '/workspace/AGENTS.md'];
  const channelCtxPath = '/content/discord/general.md';
  const dcc = makeDcc(['/content/.context/pa.md']);

  it('buildContextFiles includes channel context (first-turn)', () => {
    const files = buildContextFiles(paFiles, dcc, channelCtxPath);
    expect(files).toContain(channelCtxPath);
    expect(files.length).toBe(paFiles.length + dcc.paContextFiles.length + 1);
  });

  it('buildPreambleContextFiles excludes channel context (follow-up)', () => {
    const files = buildPreambleContextFiles(paFiles, dcc);
    expect(files).not.toContain(channelCtxPath);
    expect(files.length).toBe(paFiles.length + dcc.paContextFiles.length);
  });

  it('first-turn files are a superset of follow-up files', () => {
    const firstTurn = buildContextFiles(paFiles, dcc, channelCtxPath);
    const followUp = buildPreambleContextFiles(paFiles, dcc);
    for (const f of followUp) {
      expect(firstTurn).toContain(f);
    }
    // First turn has the channel context extra
    expect(firstTurn.length).toBe(followUp.length + 1);
  });

  it('with no channel context, both functions return the same files', () => {
    const firstTurn = buildContextFiles(paFiles, dcc, null);
    const followUp = buildPreambleContextFiles(paFiles, dcc);
    expect(firstTurn).toEqual(followUp);
  });

  it('with undefined channel context, both functions return the same files', () => {
    const firstTurn = buildContextFiles(paFiles, dcc, undefined);
    const followUp = buildPreambleContextFiles(paFiles, dcc);
    expect(firstTurn).toEqual(followUp);
  });
});

// ---------------------------------------------------------------------------
// 2. Post-preamble sections handle empty content (trimmed sections)
// ---------------------------------------------------------------------------

describe('post-preamble sections handle trimmed (empty) sections', () => {
  it('orderPostPreambleSections filters out empty-content sections', () => {
    const sections: OrderedPromptSection[] = [
      makeSection('task', 'Task data here', 'primacy'),
      makeSection('channelContext', '', 'primacy'),  // trimmed on follow-up
      makeSection('history', '', 'recency'),         // trimmed on follow-up
      makeSection('actionsReference', 'actions', 'recency'),
    ];
    const ordered = orderPostPreambleSections(sections);
    expect(ordered).toHaveLength(2);
    expect(ordered.map((s) => s.key)).toEqual(['task', 'actionsReference']);
  });

  it('assemblePostPreambleSections produces no output for all-empty sections', () => {
    const sections: OrderedPromptSection[] = [
      makeSection('channelContext', '', 'primacy'),
      makeSection('history', '', 'recency'),
      makeSection('shortTermMemory', '', 'middle'),
    ];
    expect(assemblePostPreambleSections(sections)).toBe('');
  });

  it('assemblePostPreambleSections omits only empty sections, preserves non-empty', () => {
    const sections: OrderedPromptSection[] = [
      makeSection('durableMemory', 'mem1: value', 'primacy', 'Durable memory'),
      makeSection('channelContext', '', 'primacy'),   // trimmed
      makeSection('history', '', 'recency'),          // trimmed
      makeSection('rollingSummary', 'summary text', 'recency'),
    ];
    const result = assemblePostPreambleSections(sections);
    expect(result).toContain('mem1: value');
    expect(result).toContain('summary text');
    // Should not contain empty sections
    const lines = result.split('\n');
    // No back-to-back separators from empty content
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === '---') {
        expect(lines[i + 1]).not.toBe('---');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Zone ordering is preserved after trimming
// ---------------------------------------------------------------------------

describe('zone ordering preserved after dynamic trimming', () => {
  it('primacy sections come before recency even after middle is trimmed', () => {
    const sections: OrderedPromptSection[] = [
      makeSection('task', 'task data', 'primacy'),
      makeSection('shortTermMemory', '', 'middle'),   // trimmed
      makeSection('openTasks', '', 'middle'),          // trimmed
      makeSection('actionsReference', 'action schema', 'recency'),
    ];
    const ordered = orderPostPreambleSections(sections);
    expect(ordered).toHaveLength(2);
    expect(ordered[0].key).toBe('task');
    expect(ordered[1].key).toBe('actionsReference');
  });

  it('zone map assigns channel-independent sections correctly', () => {
    const zoneMap = getSectionZoneMap();
    // These sections should not depend on channel:
    expect(zoneMap['task']?.zone).toBe('primacy');
    expect(zoneMap['durableMemory']?.zone).toBe('primacy');
    expect(zoneMap['rollingSummary']?.zone).toBe('recency');
    expect(zoneMap['history']?.zone).toBe('recency');
    expect(zoneMap['actionsReference']?.zone).toBe('recency');
  });

  it('intra-zone ordering is stable (deterministic for prefix caching)', () => {
    const zoneMap = getSectionZoneMap();
    // Within recency: rollingSummary < history < replyRef < actionsReference
    expect(zoneMap['rollingSummary']?.order).toBeLessThan(zoneMap['history']?.order ?? Infinity);
    expect(zoneMap['history']?.order).toBeLessThan(zoneMap['replyRef']?.order ?? Infinity);
    expect(zoneMap['replyRef']?.order).toBeLessThan(zoneMap['actionsReference']?.order ?? Infinity);
  });
});

// ---------------------------------------------------------------------------
// 4. Token estimation reflects content reduction
// ---------------------------------------------------------------------------

describe('token estimation reflects dynamic trimming', () => {
  it('estimateTokensFromChars scales linearly with char count', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(400)).toBe(100);
    expect(estimateTokensFromChars(12000)).toBe(3000);
  });

  it('estimateTokensFromChars handles edge cases', () => {
    expect(estimateTokensFromChars(-1)).toBe(0);
    expect(estimateTokensFromChars(NaN)).toBe(0);
    expect(estimateTokensFromChars(Infinity)).toBe(0);
  });

  it('section estimates reflect zero chars for trimmed sections', () => {
    const contextSections: InlinedContextSection[] = [
      makeInlinedSection('/workspace/SOUL.md', '--- SOUL.md ---\nYou are Claw.'),
    ];

    const estimates = buildPromptSectionEstimates({
      contextSections,
      channelContextPath: null,
      durableSection: 'mem: value',
      coldStorageSection: '',
      summarySection: 'conversation summary',
      shortTermSection: '',    // trimmed on follow-up
      taskSection: '',
      openTasksSection: '',
      actionsReferenceSection: 'action schemas here',
    });

    // Trimmed sections should show 0 chars and not included
    expect(estimates.sections.shortTermMemory.chars).toBe(0);
    expect(estimates.sections.shortTermMemory.included).toBe(false);
    expect(estimates.sections.tasks.chars).toBe(0);
    expect(estimates.sections.tasks.included).toBe(false);

    // Non-trimmed sections should be included
    expect(estimates.sections.durableMemory.chars).toBeGreaterThan(0);
    expect(estimates.sections.durableMemory.included).toBe(true);
    expect(estimates.sections.actionsReference.chars).toBeGreaterThan(0);
    expect(estimates.sections.actionsReference.included).toBe(true);
  });

  it('total token estimate decreases when sections are trimmed', () => {
    const contextSections: InlinedContextSection[] = [
      makeInlinedSection('/workspace/SOUL.md', '--- SOUL.md ---\nYou are Claw.'),
    ];

    const fullChannelCtx = 'A'.repeat(4000); // ~1000 tokens of channel context
    const fullHistory = 'B'.repeat(8000);     // ~2000 tokens of history

    const firstTurnEstimates = buildPromptSectionEstimates({
      contextSections: [
        ...contextSections,
        makeInlinedSection('/content/discord/general.md', fullChannelCtx),
      ],
      channelContextPath: '/content/discord/general.md',
      durableSection: 'mem',
      shortTermSection: 'recent activity',
      summarySection: 'summary',
      actionsReferenceSection: 'actions',
    });

    const followUpEstimates = buildPromptSectionEstimates({
      contextSections,
      channelContextPath: null,
      durableSection: 'mem',
      shortTermSection: '',        // trimmed
      summarySection: 'summary',
      actionsReferenceSection: 'actions',
    });

    // Follow-up should have fewer total tokens
    expect(followUpEstimates.totalEstTokens).toBeLessThan(firstTurnEstimates.totalEstTokens);

    // Channel context should be 0 on follow-up
    expect(followUpEstimates.sections.channelContext.chars).toBe(0);
    expect(followUpEstimates.sections.channelContext.included).toBe(false);

    // First turn should have channel context
    expect(firstTurnEstimates.sections.channelContext.chars).toBeGreaterThan(0);
    expect(firstTurnEstimates.sections.channelContext.included).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. formatOrderedSection handles labels correctly for trimmed/non-trimmed
// ---------------------------------------------------------------------------

describe('formatOrderedSection with dynamic sections', () => {
  it('formats section with label', () => {
    const section = makeSection('durableMemory', 'item1: val', 'primacy', 'Durable memory');
    const result = formatOrderedSection(section);
    expect(result).toBe('---\nDurable memory:\nitem1: val');
  });

  it('formats section without label', () => {
    const section = makeSection('task', 'task json', 'primacy');
    const result = formatOrderedSection(section);
    expect(result).toBe('---\ntask json');
  });
});

// ---------------------------------------------------------------------------
// 6. Full prompt composition — preamble + trimmed post-preamble
// ---------------------------------------------------------------------------

describe('full prompt composition with trimming', () => {
  it('preamble is unaffected by post-preamble trimming', () => {
    const ctx = '--- SOUL.md ---\nYou are Claw.';
    const preamble = buildPromptPreamble(ctx);

    // Simulate first turn: full post-preamble
    const firstTurnSections: OrderedPromptSection[] = [
      makeSection('durableMemory', 'mem data', 'primacy', 'Durable memory'),
      makeSection('shortTermMemory', 'recent activity log', 'middle', 'Recent activity'),
      makeSection('history', 'user: hello\nbot: hi there', 'recency', 'Recent conversation'),
      makeSection('actionsReference', 'action schema json', 'recency'),
    ];

    // Simulate follow-up: trimmed post-preamble
    const followUpSections: OrderedPromptSection[] = [
      makeSection('durableMemory', 'mem data', 'primacy', 'Durable memory'),
      makeSection('shortTermMemory', '', 'middle', 'Recent activity'),   // trimmed
      makeSection('history', 'user: followup question', 'recency', 'Recent conversation'),  // only new msgs
      makeSection('actionsReference', 'action schema json', 'recency'),
    ];

    const firstTurnPost = assemblePostPreambleSections(firstTurnSections);
    const followUpPost = assemblePostPreambleSections(followUpSections);

    // Preamble is the same in both turns
    const firstTurnPrompt = preamble + '\n\n' + firstTurnPost;
    const followUpPrompt = preamble + '\n\n' + followUpPost;

    // Both start with the same preamble prefix
    expect(firstTurnPrompt.startsWith(preamble)).toBe(true);
    expect(followUpPrompt.startsWith(preamble)).toBe(true);

    // Follow-up is shorter (trimmed sections)
    expect(followUpPrompt.length).toBeLessThan(firstTurnPrompt.length);

    // The shared prefix (preamble) is identical
    const sharedLen = preamble.length;
    expect(firstTurnPrompt.slice(0, sharedLen)).toBe(followUpPrompt.slice(0, sharedLen));
  });

  it('follow-up trimming removes short-term memory but keeps durable memory', () => {
    const followUpSections: OrderedPromptSection[] = [
      makeSection('durableMemory', 'important user notes', 'primacy', 'Durable memory'),
      makeSection('shortTermMemory', '', 'middle'),  // trimmed
    ];
    const result = assemblePostPreambleSections(followUpSections);
    expect(result).toContain('important user notes');
    expect(result).not.toContain('Recent activity');
  });

  it('follow-up history contains only new messages (shorter than first turn)', () => {
    const firstTurnHistory = 'user: hello\nbot: hi\nuser: how are you\nbot: good';
    const followUpHistory = 'user: one more thing';  // only the new message

    const firstTurnSections: OrderedPromptSection[] = [
      makeSection('history', firstTurnHistory, 'recency', 'Recent conversation'),
    ];
    const followUpSections: OrderedPromptSection[] = [
      makeSection('history', followUpHistory, 'recency', 'Recent conversation'),
    ];

    const firstResult = assemblePostPreambleSections(firstTurnSections);
    const followUpResult = assemblePostPreambleSections(followUpSections);

    expect(followUpResult.length).toBeLessThan(firstResult.length);
  });
});
