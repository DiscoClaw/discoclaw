import { describe, expect, it } from 'vitest';
import { OnboardingFlow } from './onboarding-flow.js';

function startFlow(displayName = 'TestUser') {
  const flow = new OnboardingFlow();
  const greeting = flow.start(displayName);
  return { flow, greeting };
}

/** Run a flow to CONFIRM step. */
function flowToConfirm() {
  const { flow } = startFlow();
  flow.handleInput('David');            // NAME
  flow.handleInput('America/New_York'); // TIMEZONE
  flow.handleInput('yes');              // CHECKIN → CONFIRM
  return flow;
}

describe('OnboardingFlow', () => {
  it('start() returns greeting with first question', () => {
    const { greeting } = startFlow('Dave');
    expect(greeting.done).toBe(false);
    expect(greeting.reply).toContain('Dave');
    expect(greeting.reply).toContain('name');
  });

  it('updates lastActivityTimestamp on start and handleInput', () => {
    const { flow } = startFlow();
    const t1 = flow.lastActivityTimestamp;
    expect(t1).toBeGreaterThan(0);

    flow.handleInput('David');
    expect(flow.lastActivityTimestamp).toBeGreaterThanOrEqual(t1);
  });

  // --- Happy path ---
  it('full flow: name → timezone → check-in → confirm', () => {
    const { flow } = startFlow();

    let r = flow.handleInput('David');
    expect(r.reply).toContain('David');
    expect(r.done).toBe(false);

    r = flow.handleInput('America/Chicago');
    expect(r.reply).toContain('morning');

    r = flow.handleInput('yes');
    // Should show confirmation
    expect(r.reply).toContain('David');
    expect(r.reply).toContain('America/Chicago');
    expect(r.reply).toContain('yes');
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
  it('editing field 1 (name) at confirmation returns to confirm with updated value', () => {
    const flow = flowToConfirm();
    let r = flow.handleInput('1'); // Edit name
    expect(r.reply).toContain('name');

    r = flow.handleInput('NewName');
    expect(r.reply).toContain('NewName');
    expect(r.reply).toContain('yes');
  });

  it('editing field 2 (timezone) at confirmation returns to confirm with updated value', () => {
    const flow = flowToConfirm();
    let r = flow.handleInput('2'); // Edit timezone
    expect(r.reply).toContain('timezone');

    r = flow.handleInput('Europe/London');
    expect(r.reply).toContain('Europe/London');
    expect(r.reply).toContain('yes');
  });

  it('editing field 3 (check-in) at confirmation returns to confirm with updated value', () => {
    const flow = flowToConfirm();
    let r = flow.handleInput('3'); // Edit check-in
    expect(r.reply).toContain('morning');

    r = flow.handleInput('no');
    expect(r.reply).toContain('No');
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
    let r = flow.handleInput('1'); // Edit name
    expect(r.reply).toContain('name');
    r = flow.handleInput('FixedName');
    expect(r.reply).toContain('FixedName'); // Confirmation
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

  // --- Timezone validation ---
  it.each([
    ['PST', 'America/Los_Angeles'],
    ['PDT', 'America/Los_Angeles'],
    ['EST', 'America/New_York'],
    ['EDT', 'America/New_York'],
    ['CST', 'America/Chicago'],
    ['MST', 'America/Denver'],
    ['GMT', 'Etc/GMT'],
    ['UTC', 'UTC'],
    ['CET', 'Europe/Paris'],
    ['BST', 'Europe/London'],
    ['IST', 'Asia/Kolkata'],
    ['JST', 'Asia/Tokyo'],
  ])('timezone abbreviation %s maps to %s', (abbr, expected) => {
    const { flow } = startFlow();
    flow.handleInput('David');
    flow.handleInput(abbr);
    const vals = flow.getValues();
    expect(vals.timezone).toBe(expected);
  });

  it('IANA timezone name is accepted as-is', () => {
    const { flow } = startFlow();
    flow.handleInput('David');
    const r = flow.handleInput('Europe/Berlin');
    expect(r.reply).toContain('morning'); // advanced to CHECKIN
    expect(flow.getValues().timezone).toBe('Europe/Berlin');
  });

  it('invalid timezone re-prompts', () => {
    const { flow } = startFlow();
    flow.handleInput('David');
    const r = flow.handleInput('NotATimezone');
    expect(r.done).toBe(false);
    expect(r.reply).toContain('recognize');
  });

  // --- Morning check-in parsing ---
  it.each(['yes', 'y', 'yeah', 'yep', 'sure', 'ok', '1', 'true'])(
    'checkin "%s" is treated as yes',
    (input) => {
      const { flow } = startFlow();
      flow.handleInput('David');
      flow.handleInput('UTC');
      flow.handleInput(input);
      expect(flow.getValues().morningCheckin).toBe(true);
    },
  );

  it.each(['no', 'n', 'nope', 'nah', '0', 'false'])(
    'checkin "%s" is treated as no',
    (input) => {
      const { flow } = startFlow();
      flow.handleInput('David');
      flow.handleInput('UTC');
      flow.handleInput(input);
      expect(flow.getValues().morningCheckin).toBe(false);
    },
  );

  it('invalid check-in input re-prompts', () => {
    const { flow } = startFlow();
    flow.handleInput('David');
    flow.handleInput('UTC');
    const r = flow.handleInput('maybe');
    expect(r.done).toBe(false);
    expect(r.reply).toContain('yes or no');
  });

  // --- Getters ---
  it('getValues returns collected values', () => {
    const flow = flowToConfirm();
    const vals = flow.getValues();
    expect(vals.userName).toBe('David');
    expect(vals.timezone).toBe('America/New_York');
    expect(vals.morningCheckin).toBe(true);
  });

  it('getValuesWithDefaults fills missing fields with defaults', () => {
    const flow = new OnboardingFlow();
    flow.start('Dave');
    // No questions answered
    const vals = flow.getValuesWithDefaults('Dave', 'America/Chicago');
    expect(vals.userName).toBe('Dave');
    expect(vals.timezone).toBe('America/Chicago');
    expect(vals.morningCheckin).toBe(false);
  });

  it('getValuesWithDefaults preserves answered fields', () => {
    const { flow } = startFlow();
    flow.handleInput('David'); // userName answered, timezone/checkin not yet
    const vals = flow.getValuesWithDefaults('Dave', 'UTC');
    expect(vals.userName).toBe('David'); // answered value kept
    expect(vals.timezone).toBe('UTC');   // default used
    expect(vals.morningCheckin).toBe(false); // default used
  });

  // --- Public API surface ---
  it('public properties exist', () => {
    const flow = new OnboardingFlow();
    expect(typeof flow.lastActivityTimestamp).toBe('number');
    expect(flow.channelMode).toBe('dm');
    expect(flow.hasRedirected).toBe(false);
    expect(flow.channelId).toBeUndefined();
  });
});
