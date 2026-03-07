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
      activeTaskId: 'ws-1170',
      currentFocus: 'Implement continuation capsule parsing',
      nextStep: 'Wire the parser into session persistence',
      blockedOn: 'Need the persistence hook',
    };

    expect(renderContinuationCapsule(capsule)).toBe(
      '<continuation-capsule>\n'
      + '{"activeTaskId":"ws-1170","currentFocus":"Implement continuation capsule parsing","nextStep":"Wire the parser into session persistence","blockedOn":"Need the persistence hook"}\n'
      + '</continuation-capsule>',
    );
  });

  it('parses and strips a rendered capsule block', () => {
    const input = [
      'Working the task.',
      '<continuation-capsule>',
      '{"activeTaskId":"ws-1170","currentFocus":"Implement continuation capsule parsing","nextStep":"Add prompt injection later","blockedOn":"No integration yet"}',
      '</continuation-capsule>',
      'Visible reply text.',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toEqual({
      activeTaskId: 'ws-1170',
      currentFocus: 'Implement continuation capsule parsing',
      nextStep: 'Add prompt injection later',
      blockedOn: 'No integration yet',
    });
    expect(parsed.cleanText).toBe('Working the task.\n\nVisible reply text.');
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]!.raw).toContain('"currentFocus":"Implement continuation capsule parsing"');
  });

  it('supports line-based capsule bodies', () => {
    const input = [
      '<continuation-capsule>',
      'active_task_id: ws-1170',
      'current_focus: Preserve the current task across recompression',
      'next_step: Persist the latest capsule beside the summary',
      'blocked_on: Need prompt wiring',
      '</continuation-capsule>',
    ].join('\n');

    expect(parseContinuationCapsule(input).capsule).toEqual({
      activeTaskId: 'ws-1170',
      currentFocus: 'Preserve the current task across recompression',
      nextStep: 'Persist the latest capsule beside the summary',
      blockedOn: 'Need prompt wiring',
    });
  });

  it('ignores capsule-looking tags inside markdown code and parses real blocks outside code', () => {
    const input = [
      '```md',
      '<continuation-capsule>',
      '{"currentFocus":"ignore","nextStep":"ignore"}',
      '</continuation-capsule>',
      '```',
      '',
      'Literal inline code: `<continuation-capsule>{"currentFocus":"still ignore","nextStep":"ignore"}</continuation-capsule>`.',
      '',
      '<continuation-capsule>',
      '{"currentFocus":"Use the real block","nextStep":"Persist it"}',
      '</continuation-capsule>',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toEqual({
      currentFocus: 'Use the real block',
      nextStep: 'Persist it',
    });
    expect(parsed.cleanText).toContain('```md');
    expect(parsed.cleanText).toContain('Literal inline code');
    expect(parsed.cleanText).not.toContain('"Use the real block"');
  });

  it('returns the last valid capsule when multiple blocks are present', () => {
    const input = [
      '<continuation-capsule>',
      '{"currentFocus":"Old task","nextStep":"Old step","blockedOn":"Old blocker"}',
      '</continuation-capsule>',
      '',
      '<continuation-capsule>',
      '{"currentFocus":"Current task","nextStep":"Current step","blockedOn":"Current blocker"}',
      '</continuation-capsule>',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.capsule).toEqual({
      currentFocus: 'Current task',
      nextStep: 'Current step',
      blockedOn: 'Current blocker',
    });
  });

  it('strips invalid capsule blocks from visible text while leaving capsule state unset', () => {
    const input = [
      'Before',
      '<continuation-capsule>',
      '{"currentFocus":"Missing next step"}',
      '</continuation-capsule>',
      'After',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toBeNull();
    expect(parsed.blocks).toEqual([]);
    expect(parsed.cleanText).toBe('Before\n\nAfter');
  });

  it('strips trailing unterminated capsule blocks from visible text', () => {
    const input = [
      'Before',
      '<continuation-capsule>',
      '{"currentFocus":"Keep focus","nextStep":"Missing close"',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toBeNull();
    expect(parsed.blocks).toEqual([]);
    expect(parsed.cleanText).toBe('Before');
  });

  it('truncates capsule fields to 200 characters', () => {
    const tooLong = 'x'.repeat(240);
    const input = [
      '<continuation-capsule>',
      JSON.stringify({
        activeTaskId: tooLong,
        currentFocus: tooLong,
        nextStep: tooLong,
        blockedOn: tooLong,
      }),
      '</continuation-capsule>',
    ].join('\n');

    const parsed = parseContinuationCapsule(input);

    expect(parsed.capsule).toEqual({
      activeTaskId: 'x'.repeat(200),
      currentFocus: 'x'.repeat(200),
      nextStep: 'x'.repeat(200),
      blockedOn: 'x'.repeat(200),
    });
  });

  it('reports raw ranges for parsed blocks', () => {
    const input = [
      'Reply text',
      '<continuation-capsule>',
      '{"currentFocus":"Track offsets","nextStep":"Use them to strip blocks"}',
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
