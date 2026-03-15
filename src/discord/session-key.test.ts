import { describe, expect, it } from 'vitest';

import { discordSessionKey } from './session-key.js';

describe('discordSessionKey', () => {
  it('uses dm:<authorId> for DMs', () => {
    expect(discordSessionKey({ channelId: 'c', authorId: 'u', isDm: true })).toBe('discord:dm:u');
  });

  it('uses thread:<threadId> for threads', () => {
    expect(discordSessionKey({ channelId: 'c', authorId: 'u', isDm: false, threadId: 't' })).toBe('discord:thread:t');
  });

  it('uses channel:<channelId> for normal channels', () => {
    expect(discordSessionKey({ channelId: 'c', authorId: 'u', isDm: false })).toBe('discord:channel:c');
  });
});

