import { describe, it, expect } from 'vitest';
import { buildVoiceActionFlags } from './voice-action-flags.js';

describe('buildVoiceActionFlags', () => {
  const allEnabled = {
    discordActionsMessaging: true,
    discordActionsTasks: true,
    tasksEnabled: true,
    taskCtxAvailable: true,
    discordActionsMemory: true,
    durableMemoryEnabled: true,
  };

  it('enables messaging, tasks, memory when all env flags are true', () => {
    const flags = buildVoiceActionFlags(allEnabled);
    expect(flags.messaging).toBe(true);
    expect(flags.tasks).toBe(true);
    expect(flags.memory).toBe(true);
  });

  it('hard-disables all non-allowlisted categories', () => {
    const flags = buildVoiceActionFlags(allEnabled);
    expect(flags.channels).toBe(false);
    expect(flags.guild).toBe(false);
    expect(flags.moderation).toBe(false);
    expect(flags.polls).toBe(false);
    expect(flags.crons).toBe(false);
    expect(flags.botProfile).toBe(false);
    expect(flags.forge).toBe(false);
    expect(flags.plan).toBe(false);
    expect(flags.config).toBe(false);
    expect(flags.defer).toBe(false);
    expect(flags.imagegen).toBe(false);
    expect(flags.voice).toBe(false);
  });

  it('respects env-level messaging override', () => {
    const flags = buildVoiceActionFlags({ ...allEnabled, discordActionsMessaging: false });
    expect(flags.messaging).toBe(false);
  });

  it('respects env-level tasks override', () => {
    const flags = buildVoiceActionFlags({ ...allEnabled, discordActionsTasks: false });
    expect(flags.tasks).toBe(false);
  });

  it('disables tasks when tasksEnabled is false', () => {
    const flags = buildVoiceActionFlags({ ...allEnabled, tasksEnabled: false });
    expect(flags.tasks).toBe(false);
  });

  it('disables tasks when taskCtxAvailable is false', () => {
    const flags = buildVoiceActionFlags({ ...allEnabled, taskCtxAvailable: false });
    expect(flags.tasks).toBe(false);
  });

  it('respects env-level memory override', () => {
    const flags = buildVoiceActionFlags({ ...allEnabled, discordActionsMemory: false });
    expect(flags.memory).toBe(false);
  });

  it('disables memory when durableMemoryEnabled is false', () => {
    const flags = buildVoiceActionFlags({ ...allEnabled, durableMemoryEnabled: false });
    expect(flags.memory).toBe(false);
  });

  it('disables all voice-allowed categories when all env flags are false', () => {
    const flags = buildVoiceActionFlags({
      discordActionsMessaging: false,
      discordActionsTasks: false,
      tasksEnabled: false,
      taskCtxAvailable: false,
      discordActionsMemory: false,
      durableMemoryEnabled: false,
    });
    expect(flags.messaging).toBe(false);
    expect(flags.tasks).toBe(false);
    expect(flags.memory).toBe(false);
  });

  it('non-allowlisted categories remain false even when all env flags are true', () => {
    const flags = buildVoiceActionFlags(allEnabled);
    const nonAllowlisted = [
      'channels', 'guild', 'moderation', 'polls', 'crons',
      'botProfile', 'forge', 'plan', 'config', 'defer', 'imagegen', 'voice',
    ] as const;
    for (const key of nonAllowlisted) {
      expect(flags[key]).toBe(false);
    }
  });
});
