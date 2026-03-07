import { describe, expect, it } from 'vitest';
import {
  extractContinuationCapsuleBlocks,
  parseContinuationCapsule,
  renderContinuationCapsule,
  type ContinuationCapsule,
} from './capsule.js';

describe('capsule', () => {
  it('renders a canonical JSON capsule block', () => {
    const capsule: ContinuationCapsule = {
      currentTask: 'Implement continuation capsule parsing',
      nextStep: 'Wire the parser into session persistence',
      blockers: ['Need the persistence hook'],
    };

    expect(renderContinuationCapsule(capsule)).toBe(
      '<continuation-capsule>\n'
      + '{"currentTask":"Implement continuation capsule parsing","nextStep":"Wire the parser into session persistence","blockers":["Need the persistence hook"]}\n'
      + '</continuation-capsule>',
    );
  });

  it('parses and strips a rendered capsule block', () => {
    const input = [
      'Working the task.',
      '<continuation-capsule>',
      '{"currentTask":"Implement continuation capsule parsing","nextStep":"Add prompt injection later","blockers":["No integration yet"]}',
      '</continuation-capsule>',
      'Visible reply text.',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toEqual({
      currentTask: 'Implement continuation capsule parsing',
      nextStep: 'Add prompt injection later',
      blockers: ['No integration yet'],
    });
    expect(parsed.cleanText).toBe('Working the task.\n\nVisible reply text.');
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]!.raw).toContain('"currentTask":"Implement continuation capsule parsing"');
  });

  it('supports line-based capsule bodies', () => {
    const input = [
      '<continuation-capsule>',
      'current_task: Preserve the current task across recompression',
      'next_step: Persist the latest capsule beside the summary',
      'blockers:',
      '- Need prompt wiring',
      '- Need storage wiring',
      '</continuation-capsule>',
    ].join('\n');

    expect(parseContinuationCapsule(input).capsule).toEqual({
      currentTask: 'Preserve the current task across recompression',
      nextStep: 'Persist the latest capsule beside the summary',
      blockers: ['Need prompt wiring', 'Need storage wiring'],
    });
  });

  it('ignores capsule-looking tags inside markdown code and parses real blocks outside code', () => {
    const input = [
      '```md',
      '<continuation-capsule>',
      '{"currentTask":"ignore","nextStep":"ignore","blockers":[]}',
      '</continuation-capsule>',
      '```',
      '',
      'Literal inline code: `<continuation-capsule>{"currentTask":"still ignore","nextStep":"ignore","blockers":[]}</continuation-capsule>`.',
      '',
      '<continuation-capsule>',
      '{"currentTask":"Use the real block","nextStep":"Persist it","blockers":[]}',
      '</continuation-capsule>',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toEqual({
      currentTask: 'Use the real block',
      nextStep: 'Persist it',
      blockers: [],
    });
    expect(parsed.cleanText).toContain('```md');
    expect(parsed.cleanText).toContain('Literal inline code');
    expect(parsed.cleanText).not.toContain('"Use the real block"');
  });

  it('returns the last valid capsule when multiple blocks are present', () => {
    const input = [
      '<continuation-capsule>',
      '{"currentTask":"Old task","nextStep":"Old step","blockers":["Old blocker"]}',
      '</continuation-capsule>',
      '',
      '<continuation-capsule>',
      '{"currentTask":"Current task","nextStep":"Current step","blockers":["Current blocker"]}',
      '</continuation-capsule>',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.capsule).toEqual({
      currentTask: 'Current task',
      nextStep: 'Current step',
      blockers: ['Current blocker'],
    });
  });

  it('keeps invalid capsule blocks visible and unparsed', () => {
    const input = [
      'Before',
      '<continuation-capsule>',
      '{"currentTask":"Missing next step","blockers":[]}',
      '</continuation-capsule>',
      'After',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toBeNull();
    expect(parsed.blocks).toEqual([]);
    expect(parsed.cleanText).toBe(input);
  });

  it('reports raw ranges for parsed blocks', () => {
    const input = [
      'Reply text',
      '<continuation-capsule>',
      '{"currentTask":"Track offsets","nextStep":"Use them to strip blocks","blockers":[]}',
      '</continuation-capsule>',
    ].join('\n');

    const blocks = extractContinuationCapsuleBlocks(input);

    expect(blocks).toHaveLength(1);
    const start = input.indexOf('<continuation-capsule>');
    expect(blocks[0]!.range).toEqual({
      start,
      end: start + blocks[0]!.raw.length,
    });
  });
});
