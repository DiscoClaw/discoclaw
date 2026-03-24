/**
 * Regression tests for onboarding channel selection.
 *
 * Bug: guild-originated onboarding defaulted to DM-first instead of staying
 * in the server channel where the conversation started.
 *
 * Expected behavior: prefer the originating guild channel, with DM as a
 * fallback only when the guild channel is unavailable or the bot lacks
 * send permissions.
 */

import { describe, expect, it } from 'vitest';
import { OnboardingFlow } from '../../src/onboarding/onboarding-flow.js';
import type { ChannelContext } from '../../src/onboarding/onboarding-flow.js';

describe('onboarding channel selection (DM-regression)', () => {
  // -------------------------------------------------------------------------
  // Guild-originated: should stay in guild channel
  // -------------------------------------------------------------------------

  it('prefers guild channel when started from a guild channel with send permissions', () => {
    const flow = new OnboardingFlow();
    const ctx: ChannelContext = { guildChannelId: 'guild-ch-1', canSend: true };
    flow.start('Alice', ctx);

    expect(flow.channelMode).toBe('guild');
    expect(flow.channelId).toBe('guild-ch-1');
  });

  it('prefers guild channel when canSend is undefined (optimistic default)', () => {
    const flow = new OnboardingFlow();
    const ctx: ChannelContext = { guildChannelId: 'guild-ch-2' };
    flow.start('Bob', ctx);

    expect(flow.channelMode).toBe('guild');
    expect(flow.channelId).toBe('guild-ch-2');
  });

  it('returns greeting reply when started from a guild channel', () => {
    const flow = new OnboardingFlow();
    const ctx: ChannelContext = { guildChannelId: 'guild-ch-1', canSend: true };
    const result = flow.start('Carol', ctx);

    expect(result.done).toBe(false);
    expect(result.reply).toContain('Carol');
    expect(result.reply).toContain('name');
  });

  // -------------------------------------------------------------------------
  // DM fallback: when guild channel is NOT available
  // -------------------------------------------------------------------------

  it('falls back to DM when canSend is explicitly false', () => {
    const flow = new OnboardingFlow();
    const ctx: ChannelContext = { guildChannelId: 'guild-ch-3', canSend: false };
    flow.start('Dave', ctx);

    expect(flow.channelMode).toBe('dm');
    expect(flow.channelId).toBeUndefined();
  });

  it('falls back to DM when no channel context is provided', () => {
    const flow = new OnboardingFlow();
    flow.start('Eve');

    expect(flow.channelMode).toBe('dm');
    expect(flow.channelId).toBeUndefined();
  });

  it('falls back to DM when channel context is undefined', () => {
    const flow = new OnboardingFlow();
    flow.start('Frank', undefined);

    expect(flow.channelMode).toBe('dm');
    expect(flow.channelId).toBeUndefined();
  });

  it('falls back to DM when guildChannelId is empty string', () => {
    const flow = new OnboardingFlow();
    const ctx: ChannelContext = { guildChannelId: '', canSend: true };
    flow.start('Grace', ctx);

    expect(flow.channelMode).toBe('dm');
    expect(flow.channelId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Default state: before start() is called
  // -------------------------------------------------------------------------

  it('defaults to DM mode before start() is called', () => {
    const flow = new OnboardingFlow();

    expect(flow.channelMode).toBe('dm');
    expect(flow.channelId).toBeUndefined();
    expect(flow.hasRedirected).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Full flow: guild-originated onboarding stays in guild channel throughout
  // -------------------------------------------------------------------------

  it('guild-originated flow maintains guild channel mode through all steps', () => {
    const flow = new OnboardingFlow();
    const ctx: ChannelContext = { guildChannelId: 'guild-ch-1', canSend: true };
    flow.start('Alice', ctx);

    // Verify guild mode persists through each step
    expect(flow.channelMode).toBe('guild');

    flow.handleInput('Alice');          // NAME
    expect(flow.channelMode).toBe('guild');

    flow.handleInput('America/Chicago'); // TIMEZONE
    expect(flow.channelMode).toBe('guild');

    flow.handleInput('yes');             // CHECKIN → CONFIRM
    expect(flow.channelMode).toBe('guild');

    flow.handleInput('yes');             // CONFIRM → WRITING
    expect(flow.channelMode).toBe('guild');
    expect(flow.channelId).toBe('guild-ch-1');
  });

  it('DM-originated flow maintains DM channel mode through all steps', () => {
    const flow = new OnboardingFlow();
    flow.start('Bob');

    expect(flow.channelMode).toBe('dm');

    flow.handleInput('Bob');
    expect(flow.channelMode).toBe('dm');

    flow.handleInput('UTC');
    expect(flow.channelMode).toBe('dm');

    flow.handleInput('no');
    expect(flow.channelMode).toBe('dm');

    flow.handleInput('yes');
    expect(flow.channelMode).toBe('dm');
    expect(flow.channelId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Redirect flag: only used when messages arrive on wrong channel
  // -------------------------------------------------------------------------

  it('hasRedirected starts false and is not set by normal flow', () => {
    const flow = new OnboardingFlow();
    flow.start('Alice', { guildChannelId: 'guild-ch-1', canSend: true });

    expect(flow.hasRedirected).toBe(false);

    flow.handleInput('Alice');
    flow.handleInput('UTC');
    flow.handleInput('yes');
    flow.handleInput('yes');

    expect(flow.hasRedirected).toBe(false);
  });
});
