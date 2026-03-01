import { describe, expect, it } from 'vitest';
import { expandCronPlaceholders, buildCronPromptBody } from './cron-prompt.js';

// ---------------------------------------------------------------------------
// expandCronPlaceholders
// ---------------------------------------------------------------------------

describe('expandCronPlaceholders', () => {
  it('replaces {{channel}} placeholder', () => {
    expect(expandCronPlaceholders('Post to {{channel}}', 'general', 'ch-123')).toBe('Post to general');
  });

  it('replaces {{channelId}} placeholder', () => {
    expect(expandCronPlaceholders('Channel ID: {{channelId}}', 'general', 'ch-123')).toBe(
      'Channel ID: ch-123',
    );
  });

  it('replaces both placeholders in one string', () => {
    expect(expandCronPlaceholders('{{channel}} ({{channelId}})', 'alerts', 'ch-999')).toBe(
      'alerts (ch-999)',
    );
  });

  it('replaces multiple occurrences of the same placeholder', () => {
    expect(expandCronPlaceholders('{{channel}} and {{channel}}', 'general', 'ch-1')).toBe(
      'general and general',
    );
  });

  it('leaves text unchanged when no placeholders are present', () => {
    expect(expandCronPlaceholders('No placeholders here.', 'general', 'ch-1')).toBe(
      'No placeholders here.',
    );
  });

  it('expands {{channelId}} to empty string when channelId is empty', () => {
    const result = expandCronPlaceholders('ID: {{channelId}}', 'general', '');
    expect(result).toBe('ID: ');
    expect(result).not.toContain('{{channelId}}');
  });
});

// ---------------------------------------------------------------------------
// buildCronPromptBody — default routing mode
// ---------------------------------------------------------------------------

describe('buildCronPromptBody — default routing mode', () => {
  it('includes the job name', () => {
    const body = buildCronPromptBody({
      jobName: 'Morning Digest',
      promptTemplate: 'Summarize overnight activity.',
      channel: 'digest',
    });
    expect(body).toContain('cron job named "Morning Digest"');
  });

  it('includes the expanded instruction', () => {
    const body = buildCronPromptBody({
      jobName: 'Test Job',
      promptTemplate: 'Summarize overnight activity.',
      channel: 'general',
    });
    expect(body).toContain('Instruction: Summarize overnight activity.');
  });

  it('includes the channel posting instruction with channel name', () => {
    const body = buildCronPromptBody({
      jobName: 'Test Job',
      promptTemplate: 'Do something.',
      channel: 'general',
    });
    expect(body).toContain('#general');
    expect(body).toContain('Do NOT explain how to post');
  });

  it('appends HEARTBEAT_OK sentinel when silent is true', () => {
    const body = buildCronPromptBody({
      jobName: 'Silent Job',
      promptTemplate: 'Check for alerts.',
      channel: 'alerts',
      silent: true,
    });
    expect(body).toContain('HEARTBEAT_OK');
  });

  it('omits the silent sentinel when silent is false', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Do it.',
      channel: 'general',
      silent: false,
    });
    expect(body).not.toContain('HEARTBEAT_OK');
  });

  it('omits the silent sentinel when silent is not set', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Do it.',
      channel: 'general',
    });
    expect(body).not.toContain('HEARTBEAT_OK');
  });

  it('separates segments with blank lines', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Do it.',
      channel: 'general',
    });
    expect(body).toContain('\n\n');
  });
});

// ---------------------------------------------------------------------------
// buildCronPromptBody — json routing mode
// ---------------------------------------------------------------------------

describe('buildCronPromptBody — json routing mode', () => {
  it('includes JSON format instructions', () => {
    const body = buildCronPromptBody({
      jobName: 'Router Job',
      promptTemplate: 'Post updates.',
      channel: 'general',
      channelId: 'ch-1',
      routingMode: 'json',
    });
    expect(body).toContain('JSON array');
    expect(body).toContain('"channel"');
    expect(body).toContain('"content"');
  });

  it('instructs to return [] when there is nothing to post', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Check things.',
      channel: 'general',
      routingMode: 'json',
    });
    expect(body).toContain('Return []');
  });

  it('instructs not to wrap JSON in code fences', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Check things.',
      channel: 'general',
      routingMode: 'json',
    });
    expect(body).toContain('Do NOT wrap the JSON in code fences');
  });

  it('lists default channel with ID when channelId is provided', () => {
    const body = buildCronPromptBody({
      jobName: 'Router Job',
      promptTemplate: 'Do stuff.',
      channel: 'alerts',
      channelId: 'ch-42',
      routingMode: 'json',
    });
    expect(body).toContain('#alerts (ID: ch-42)');
  });

  it('lists default channel without ID when channelId is absent', () => {
    const body = buildCronPromptBody({
      jobName: 'Router Job',
      promptTemplate: 'Do stuff.',
      channel: 'alerts',
      routingMode: 'json',
    });
    expect(body).toContain('#alerts');
    expect(body).not.toContain('ID: ');
  });

  it('includes extra available channels', () => {
    const body = buildCronPromptBody({
      jobName: 'Multi-channel Job',
      promptTemplate: 'Route to channels.',
      channel: 'general',
      channelId: 'ch-1',
      routingMode: 'json',
      availableChannels: [
        { name: 'alerts', id: 'ch-2' },
        { name: 'reports', id: 'ch-3' },
      ],
    });
    expect(body).toContain('#alerts (ID: ch-2)');
    expect(body).toContain('#reports (ID: ch-3)');
  });

  it('deduplicates default channel from availableChannels', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Test.',
      channel: 'general',
      channelId: 'ch-1',
      routingMode: 'json',
      availableChannels: [{ name: 'general', id: 'ch-1' }],
    });
    const matches = body.match(/#general/g);
    expect(matches).toHaveLength(1);
  });

  it('uses [] sentinel in silent mode', () => {
    const body = buildCronPromptBody({
      jobName: 'Silent JSON Job',
      promptTemplate: 'Check for alerts.',
      channel: 'alerts',
      routingMode: 'json',
      silent: true,
    });
    expect(body).toContain('`[]`');
    expect(body).not.toContain('HEARTBEAT_OK');
  });

  it('omits silent instruction in json mode when silent is not set', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Do it.',
      channel: 'general',
      routingMode: 'json',
    });
    expect(body).not.toContain('HEARTBEAT_OK');
    expect(body).not.toContain('`[]`');
  });

  it('does not include prose posting instruction in json mode', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Do it.',
      channel: 'general',
      routingMode: 'json',
    });
    expect(body).not.toContain('Do NOT explain how to post');
  });
});

// ---------------------------------------------------------------------------
// buildCronPromptBody — placeholder expansion
// ---------------------------------------------------------------------------

describe('buildCronPromptBody — placeholder expansion', () => {
  it('expands {{channel}} in promptTemplate', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Post to {{channel}} now.',
      channel: 'general',
    });
    expect(body).toContain('Post to general now.');
    expect(body).not.toContain('{{channel}}');
  });

  it('expands {{channelId}} in promptTemplate', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Channel is {{channelId}}.',
      channel: 'general',
      channelId: 'ch-99',
    });
    expect(body).toContain('Channel is ch-99.');
    expect(body).not.toContain('{{channelId}}');
  });

  it('expands {{channelId}} to empty string when channelId is not provided', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'ID: {{channelId}}',
      channel: 'general',
    });
    expect(body).not.toContain('{{channelId}}');
  });

  it('expands both placeholders together', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Channel {{channel}} with ID {{channelId}}.',
      channel: 'alerts',
      channelId: 'ch-5',
    });
    expect(body).toContain('Channel alerts with ID ch-5.');
  });
});

// ---------------------------------------------------------------------------
// expandCronPlaceholders — {{state}} placeholder
// ---------------------------------------------------------------------------

describe('expandCronPlaceholders — {{state}} placeholder', () => {
  it('expands {{state}} to JSON string of provided state', () => {
    const result = expandCronPlaceholders(
      'Current state: {{state}}',
      'general',
      'ch-1',
      { counter: 3, lastSeen: '2026-02-28' },
    );
    expect(result).toContain('"counter":3');
    expect(result).toContain('"lastSeen":"2026-02-28"');
    expect(result).not.toContain('{{state}}');
  });

  it('expands {{state}} to empty object JSON when state is undefined', () => {
    const result = expandCronPlaceholders('State: {{state}}', 'general', 'ch-1');
    expect(result).toBe('State: {}');
  });

  it('expands {{state}} to empty object JSON when state is empty', () => {
    const result = expandCronPlaceholders('State: {{state}}', 'general', 'ch-1', {});
    expect(result).toBe('State: {}');
  });
});

// ---------------------------------------------------------------------------
// buildCronPromptBody — persistent state
// ---------------------------------------------------------------------------

describe('buildCronPromptBody — persistent state', () => {
  it('includes Persistent State section when state is non-empty', () => {
    const body = buildCronPromptBody({
      jobName: 'Stateful Job',
      promptTemplate: 'Check for updates.',
      channel: 'general',
      state: { lastCheck: '2026-02-27', items: [1, 2, 3] },
    });
    expect(body).toContain('## Persistent State');
    expect(body).toContain('"lastCheck": "2026-02-27"');
    expect(body).toContain('<cron-state>');
  });

  it('omits Persistent State section when state is undefined', () => {
    const body = buildCronPromptBody({
      jobName: 'Stateless Job',
      promptTemplate: 'Say hello.',
      channel: 'general',
    });
    expect(body).not.toContain('Persistent State');
    expect(body).not.toContain('<cron-state>');
  });

  it('omits Persistent State section when state is empty object', () => {
    const body = buildCronPromptBody({
      jobName: 'Empty State Job',
      promptTemplate: 'Say hello.',
      channel: 'general',
      state: {},
    });
    expect(body).not.toContain('Persistent State');
    expect(body).not.toContain('<cron-state>');
  });

  it('truncates very large state objects', () => {
    const largeState: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      largeState[`key_${i}`] = 'x'.repeat(20);
    }
    const body = buildCronPromptBody({
      jobName: 'Large State Job',
      promptTemplate: 'Process data.',
      channel: 'general',
      state: largeState,
    });
    expect(body).toContain('## Persistent State');
    expect(body).toContain('(state truncated)');
  });

  it('includes cron-state emit instruction in the state section', () => {
    const body = buildCronPromptBody({
      jobName: 'Job',
      promptTemplate: 'Do stuff.',
      channel: 'general',
      state: { v: 1 },
    });
    expect(body).toContain('<cron-state>');
    expect(body).toContain('update');
  });
});
