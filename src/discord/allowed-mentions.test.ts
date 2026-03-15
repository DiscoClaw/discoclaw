import { describe, it, expect } from 'vitest';
import { NO_MENTIONS } from './allowed-mentions.js';
import type { MessageMentionOptions } from 'discord.js';
import type { SendTarget } from './onboarding-completion.js';

describe('NO_MENTIONS', () => {
  it('has an empty parse array', () => {
    expect(NO_MENTIONS.parse).toEqual([]);
  });

  it('is assignable to Discord.js MessageMentionOptions', () => {
    // Compile-time check: if NO_MENTIONS breaks compat with discord.js, this fails to build.
    const opts: MessageMentionOptions = NO_MENTIONS;
    expect(opts.parse).toEqual([]);
  });

  it('is assignable to SendTarget allowedMentions', () => {
    // Compile-time check: if NO_MENTIONS breaks compat with SendTarget, this fails to build.
    const opts: Parameters<SendTarget['send']>[0]['allowedMentions'] = NO_MENTIONS;
    expect(opts!.parse).toEqual([]);
  });
});
