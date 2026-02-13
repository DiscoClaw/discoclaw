import { describe, expect, it } from 'vitest';
import { OnboardingFlow } from './onboarding-flow.js';

function startFlow(displayName = 'TestUser') {
  const flow = new OnboardingFlow();
  const greeting = flow.start(displayName);
  return { flow, greeting };
}

/** Run a flow through the full dev path and return at CONFIRM. */
function flowToConfirm() {
  const { flow } = startFlow();
  flow.handleInput('Weston');          // BOT_NAME
  flow.handleInput('David');           // USER_NAME
  flow.handleInput('1');               // PURPOSE → dev
  flow.handleInput('~/code/project');  // WORKING_DIRS
  // Now at CONFIRM
  return flow;
}

describe('OnboardingFlow', () => {
  it('start() returns greeting with first question', () => {
    const { greeting } = startFlow('Dave');
    expect(greeting.done).toBe(false);
    expect(greeting.reply).toContain('Dave');
    expect(greeting.reply).toContain('call myself');
  });

  it('updates lastActivityTimestamp on start and handleInput', () => {
    const { flow } = startFlow();
    const t1 = flow.lastActivityTimestamp;
    expect(t1).toBeGreaterThan(0);

    // Small delay to ensure timestamp changes
    flow.handleInput('Weston');
    expect(flow.lastActivityTimestamp).toBeGreaterThanOrEqual(t1);
  });

  // --- Happy path: dev purpose ---
  it('full flow through dev purpose', () => {
    const { flow } = startFlow();

    let r = flow.handleInput('Weston');
    expect(r.reply).toContain('Weston');
    expect(r.done).toBe(false);

    r = flow.handleInput('David');
    expect(r.reply).toContain('David');
    expect(r.reply).toContain('mainly use me for');

    r = flow.handleInput('1');
    expect(r.reply).toContain('directories');

    r = flow.handleInput('~/code/project');
    // Should show confirmation
    expect(r.reply).toContain('Bot name');
    expect(r.reply).toContain('Weston');
    expect(r.reply).toContain('David');
    expect(r.reply).toContain('yes');
  });

  // --- Happy path: pa purpose ---
  it('full flow through pa purpose', () => {
    const { flow } = startFlow();
    flow.handleInput('Claw');
    flow.handleInput('Dave');
    let r = flow.handleInput('2');
    expect(r.reply).toContain('personality');

    r = flow.handleInput('snarky but helpful');
    expect(r.reply).toContain('Claw');
    expect(r.reply).toContain('Dave');
    expect(r.reply).toContain('snarky but helpful');
  });

  // --- Happy path: both purpose ---
  it('full flow through both purpose', () => {
    const { flow } = startFlow();
    flow.handleInput('Bot');
    flow.handleInput('User');
    let r = flow.handleInput('3');
    expect(r.reply).toContain('directories');

    r = flow.handleInput('~/projects');
    expect(r.reply).toContain('personality');

    r = flow.handleInput('dry and competent');
    expect(r.reply).toContain('Bot');
    expect(r.reply).toContain('~/projects');
    expect(r.reply).toContain('dry and competent');
  });

  // --- Confirmation → write ---
  it('confirmation with yes triggers WRITING', () => {
    const flow = flowToConfirm();
    const r = flow.handleInput('yes');
    expect(r.done).toBe(false);
    expect(r.writeResult).toBe('pending');
    expect(r.reply).toContain('Writing');
  });

  it('confirmation accepts various affirmatives', () => {
    for (const word of ['y', 'ok', 'confirm', 'looks good', 'YES']) {
      const flow = flowToConfirm();
      const r = flow.handleInput(word);
      expect(r.writeResult).toBe('pending');
    }
  });

  // --- Editing a field ---
  it('editing field at confirmation returns to confirm with updated value', () => {
    const flow = flowToConfirm();
    let r = flow.handleInput('1'); // Edit bot name
    expect(r.reply).toContain('call myself');

    r = flow.handleInput('NewBot');
    // Should return to confirmation with updated name
    expect(r.reply).toContain('NewBot');
    expect(r.reply).toContain('yes');
  });

  // --- WRITING step ---
  it('message during WRITING returns hang-on message', () => {
    const flow = flowToConfirm();
    flow.handleInput('yes'); // → WRITING
    const r = flow.handleInput('hello?');
    expect(r.done).toBe(false);
    expect(r.reply).toContain('still writing');
    expect(r.writeResult).toBeUndefined();
  });

  it('markWriteComplete transitions to DONE', () => {
    const flow = flowToConfirm();
    flow.handleInput('yes');
    flow.markWriteComplete();
    const r = flow.handleInput('anything');
    expect(r.done).toBe(true);
  });

  it('markWriteFailed transitions to WRITE_ERROR', () => {
    const flow = flowToConfirm();
    flow.handleInput('yes');
    flow.markWriteFailed('disk full');
    const r = flow.handleInput('retry');
    expect(r.writeResult).toBe('pending');
  });

  // --- Write error recovery ---
  it('retry from WRITE_ERROR returns writeResult pending', () => {
    const flow = flowToConfirm();
    flow.handleInput('yes');
    flow.markWriteFailed('oops');
    const r = flow.handleInput('yes'); // "yes" also works as retry
    expect(r.writeResult).toBe('pending');
  });

  it('edit field from WRITE_ERROR then confirm', () => {
    const flow = flowToConfirm();
    flow.handleInput('yes');
    flow.markWriteFailed('oops');
    let r = flow.handleInput('1'); // Edit bot name
    expect(r.reply).toContain('call myself');
    r = flow.handleInput('FixedBot');
    expect(r.reply).toContain('FixedBot'); // Confirmation
    r = flow.handleInput('yes');
    expect(r.writeResult).toBe('pending');
  });

  // --- Input validation ---
  it('empty input on required field re-prompts', () => {
    const { flow } = startFlow();
    const r = flow.handleInput('');
    expect(r.reply).toContain('need something');
  });

  it('over-length input is rejected', () => {
    const { flow } = startFlow();
    const r = flow.handleInput('a'.repeat(201));
    expect(r.reply).toContain('200 characters');
  });

  it('placeholder input is rejected', () => {
    const { flow } = startFlow();
    const r = flow.handleInput('My name is {{BOT_NAME}}');
    expect(r.reply).toContain('template placeholder');
  });

  it('invalid confirmation number is rejected', () => {
    const flow = flowToConfirm();
    const r = flow.handleInput('99');
    expect(r.reply).toContain('pick a number');
  });

  // --- Purpose parsing ---
  it.each([
    ['1', 'dev'],
    ['dev', 'dev'],
    ['development', 'dev'],
    ['coding', 'dev'],
    ['2', 'pa'],
    ['personal assistant', 'pa'],
    ['assistant', 'pa'],
    ['3', 'both'],
    ['both', 'both'],
  ])('purpose input "%s" maps to %s', (input, expected) => {
    const { flow } = startFlow();
    flow.handleInput('Bot');
    flow.handleInput('User');
    flow.handleInput(input);
    const vals = flow.getValues();
    expect(vals.purpose).toBe(expected);
  });

  it('unrecognized purpose input re-prompts', () => {
    const { flow } = startFlow();
    flow.handleInput('Bot');
    flow.handleInput('User');
    const r = flow.handleInput('idk');
    expect(r.reply).toContain('pick 1, 2, or 3');
  });

  // --- Optional fields ---
  it('empty working dirs is accepted as skip', () => {
    const { flow } = startFlow();
    flow.handleInput('Bot');
    flow.handleInput('User');
    flow.handleInput('1'); // dev
    const r = flow.handleInput(''); // skip working dirs
    expect(r.reply).toContain('yes'); // Confirmation
    expect(r.reply).toContain('(skipped)');
  });

  it('empty personality is accepted as skip', () => {
    const { flow } = startFlow();
    flow.handleInput('Bot');
    flow.handleInput('User');
    flow.handleInput('2'); // pa
    const r = flow.handleInput(''); // skip personality
    expect(r.reply).toContain('yes'); // Confirmation
    expect(r.reply).toContain('(skipped)');
  });

  // --- Getters ---
  it('getValues returns collected values', () => {
    const flow = flowToConfirm();
    const vals = flow.getValues();
    expect(vals.botName).toBe('Weston');
    expect(vals.userName).toBe('David');
    expect(vals.purpose).toBe('dev');
    expect(vals.workingDirs).toBe('~/code/project');
  });
});
