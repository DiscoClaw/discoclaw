import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChannelType } from 'discord.js';
import type {
  ReleaseRehearsalCheckpointPrompt,
} from '../release-rehearsal.js';

// ---------------------------------------------------------------------------
// Discord.js mock
// ---------------------------------------------------------------------------

function makeMessage(id: string, authorId: string, content: string) {
  return { id, author: { id: authorId }, content };
}

function makeMockChannel(type: number = ChannelType.GuildText) {
  const sent: Array<{ id: string; content: string }> = [];
  let sendCounter = 0;
  let replyQueue: Array<ReturnType<typeof makeMessage>> = [];

  return {
    type,
    sent,
    /** Pre-stage bot replies that `messages.fetch` will return. */
    enqueueReply(msg: ReturnType<typeof makeMessage>) {
      replyQueue.push(msg);
    },
    send: vi.fn(async (content: string) => {
      const id = `probe-${++sendCounter}`;
      const msg = makeMessage(id, 'observer-user', content);
      sent.push(msg);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async () => {
        // Return a discord.js Collection-like object (Map + .find)
        const items = [...replyQueue];
        // Drain queue after first fetch so polling converges
        replyQueue = [];
        const map = new Map<string, ReturnType<typeof makeMessage>>();
        for (const r of items) map.set(r.id, r);
        // Collection.find calls the predicate with (value, key, collection)
        (map as any).find = (fn: (v: ReturnType<typeof makeMessage>) => boolean) => {
          for (const v of map.values()) {
            if (fn(v)) return v;
          }
          return undefined;
        };
        return map;
      }),
    },
  };
}

type MockChannel = ReturnType<typeof makeMockChannel>;

let mockClientInstance: {
  login: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  user: { id: string; tag: string } | null;
  channels: {
    fetch: ReturnType<typeof vi.fn>;
  };
};

let mockChannel: MockChannel;

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => {
      return mockClientInstance;
    }),
  };
});

// ---------------------------------------------------------------------------
// Import under test (after mock registration)
// ---------------------------------------------------------------------------

const { createAutoCheckpoint } = await import('../auto-checkpoint.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOT_USER_ID = 'bot-123';
const OBSERVER_TAG = 'TestBot#0001';

function baseConfig() {
  return {
    discordToken: 'fake-token',
    channelId: 'channel-456',
    slug: 'rr-20260324-120000-abcd',
    artifacts: { taskTitle: 'rehearsal-task-1', cronName: 'rehearsal-cron-1' },
    log: vi.fn(),
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
  };
}

function setupMockClient(channelOverride?: MockChannel) {
  mockChannel = channelOverride ?? makeMockChannel();

  mockClientInstance = {
    login: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    once: vi.fn(),
    destroy: vi.fn(),
    user: { id: BOT_USER_ID, tag: OBSERVER_TAG },
    channels: {
      fetch: vi.fn(async () => mockChannel),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useRealTimers();
  setupMockClient();
});

describe('createAutoCheckpoint', () => {
  it('logs in and returns a promptCheckpoint function', async () => {
    const cfg = baseConfig();
    const ctx = await createAutoCheckpoint(cfg);

    expect(mockClientInstance.login).toHaveBeenCalledWith('fake-token');
    expect(typeof ctx.promptCheckpoint).toBe('function');
    expect(typeof ctx.dispose).toBe('function');

    ctx.dispose();
    expect(mockClientInstance.destroy).toHaveBeenCalled();
  });

  it('throws when channel is not text-based', async () => {
    const badChannel = makeMockChannel(ChannelType.GuildVoice);
    setupMockClient(badChannel);

    await expect(createAutoCheckpoint(baseConfig())).rejects.toThrow(
      /not a text-based channel/,
    );
    expect(mockClientInstance.destroy).toHaveBeenCalled();
  });

  it('throws when channel fetch returns null', async () => {
    setupMockClient();
    mockClientInstance.channels.fetch = vi.fn(async () => null);

    await expect(createAutoCheckpoint(baseConfig())).rejects.toThrow(
      /not a text-based channel/,
    );
  });

  it('waits for ready event when client is not immediately ready', async () => {
    setupMockClient();
    mockClientInstance.isReady = vi.fn(() => false);
    mockClientInstance.once = vi.fn((_event: string, cb: () => void) => {
      // Simulate ready event firing asynchronously
      queueMicrotask(cb);
    });

    const ctx = await createAutoCheckpoint(baseConfig());
    expect(mockClientInstance.once).toHaveBeenCalledWith('ready', expect.any(Function));
    ctx.dispose();
  });

  it('logs in with observerToken when provided and extracts bot ID from discordToken', async () => {
    // Encode 'bot-123' as base64 for the discordToken first segment
    const encodedBotId = Buffer.from(BOT_USER_ID).toString('base64');
    const botToken = `${encodedBotId}.fake.fake`;
    const observerToken = 'observer-token-value';

    // Observer client has a different user ID
    setupMockClient();
    mockClientInstance.user = { id: 'observer-789', tag: 'Observer#0002' };

    const cfg = {
      ...baseConfig(),
      discordToken: botToken,
      observerToken,
    };
    const ctx = await createAutoCheckpoint(cfg);

    // Should log in with observer token, not bot token
    expect(mockClientInstance.login).toHaveBeenCalledWith(observerToken);

    // Probe messages should @-mention the bot-under-test
    mockChannel.enqueueReply(makeMessage('reply-obs', BOT_USER_ID, 'Hello!'));
    await ctx.promptCheckpoint({
      id: 'checkpoint-message-handling',
      label: 'Verify Message Handling',
      instructions: ['Send a probe.'],
    });

    const sentContent = mockChannel.send.mock.calls[0]![0] as string;
    expect(sentContent).toContain(`<@${BOT_USER_ID}>`);

    ctx.dispose();
  });
});

describe('promptCheckpoint dispatch', () => {
  async function getCheckpoint() {
    const cfg = baseConfig();
    const ctx = await createAutoCheckpoint(cfg);
    return { ...ctx, cfg };
  }

  describe('checkpoint-message-handling', () => {
    it('passes when bot replies', async () => {
      mockChannel.enqueueReply(makeMessage('reply-1', BOT_USER_ID, 'Hello!'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-message-handling',
        label: 'Verify Message Handling',
        instructions: ['Send a probe.'],
      });

      expect(status).toBe('pass');
      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      expect(mockChannel.send.mock.calls[0]![0]).toContain('auto-check');
      dispose();
    });

    it('fails when bot does not reply within timeout', async () => {
      // No replies enqueued
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-message-handling',
        label: 'Verify Message Handling',
        instructions: ['Send a probe.'],
      });

      expect(status).toBe('fail');
      dispose();
    });
  });

  describe('checkpoint-follow-up-reply', () => {
    it('passes when bot replies to follow-up', async () => {
      mockChannel.enqueueReply(makeMessage('reply-2', BOT_USER_ID, 'Follow-up OK'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-follow-up-reply',
        label: 'Verify Same-Conversation Follow-Up',
        instructions: ['Send follow-up.'],
      });

      expect(status).toBe('pass');
      dispose();
    });

    it('fails when no follow-up reply', async () => {
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-follow-up-reply',
        label: 'Verify Same-Conversation Follow-Up',
        instructions: ['Send follow-up.'],
      });

      expect(status).toBe('fail');
      dispose();
    });
  });

  describe('checkpoint-task-sync', () => {
    it('passes when bot replies with task title', async () => {
      mockChannel.enqueueReply(makeMessage('reply-3', BOT_USER_ID, 'Created task: rehearsal-task-1'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-task-sync',
        label: 'Verify Task Sync',
        instructions: ['Create a task.'],
      });

      expect(status).toBe('pass');
      // Probe message should reference the task title
      expect(mockChannel.send.mock.calls[0]![0]).toContain('rehearsal-task-1');
      dispose();
    });

    it('fails when reply does not mention task title', async () => {
      mockChannel.enqueueReply(makeMessage('reply-3b', BOT_USER_ID, 'Done!'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-task-sync',
        label: 'Verify Task Sync',
        instructions: ['Create a task.'],
      });

      expect(status).toBe('fail');
      dispose();
    });

    it('fails when no reply to task request', async () => {
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-task-sync',
        label: 'Verify Task Sync',
        instructions: ['Create a task.'],
      });

      expect(status).toBe('fail');
      dispose();
    });
  });

  describe('checkpoint-cron-execution', () => {
    it('passes when bot replies with cron name', async () => {
      mockChannel.enqueueReply(makeMessage('reply-4', BOT_USER_ID, 'Created cron: rehearsal-cron-1'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-cron-execution',
        label: 'Verify Cron Execution',
        instructions: ['Create a cron.'],
      });

      expect(status).toBe('pass');
      expect(mockChannel.send.mock.calls[0]![0]).toContain('rehearsal-cron-1');
      dispose();
    });

    it('fails when reply does not mention cron name', async () => {
      mockChannel.enqueueReply(makeMessage('reply-4b', BOT_USER_ID, 'OK'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-cron-execution',
        label: 'Verify Cron Execution',
        instructions: ['Create a cron.'],
      });

      expect(status).toBe('fail');
      dispose();
    });

    it('fails when no reply to cron request', async () => {
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-cron-execution',
        label: 'Verify Cron Execution',
        instructions: ['Create a cron.'],
      });

      expect(status).toBe('fail');
      dispose();
    });
  });

  describe('checkpoint-restart-recovery', () => {
    it('passes when bot replies after restart', async () => {
      mockChannel.enqueueReply(makeMessage('reply-5', BOT_USER_ID, 'Reconnected'));
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-restart-recovery',
        label: 'Verify Restart And Recovery',
        instructions: ['Confirm reconnect.'],
      });

      expect(status).toBe('pass');
      dispose();
    });

    it('fails when no reply after restart', async () => {
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-restart-recovery',
        label: 'Verify Restart And Recovery',
        instructions: ['Confirm reconnect.'],
      });

      expect(status).toBe('fail');
      dispose();
    });
  });

  describe('record-chat-artifact-cleanup', () => {
    it('auto-passes as informational', async () => {
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'record-chat-artifact-cleanup',
        label: 'Chat Artifact Cleanup',
        instructions: [],
      });

      expect(status).toBe('pass');
      // Should NOT send any probe messages
      expect(mockChannel.send).not.toHaveBeenCalled();
      dispose();
    });
  });

  describe('unknown checkpoint', () => {
    it('returns skipped for unrecognised checkpoint IDs', async () => {
      const { promptCheckpoint, dispose } = await getCheckpoint();

      const status = await promptCheckpoint({
        id: 'checkpoint-nonexistent',
        label: 'Unknown',
        instructions: [],
      });

      expect(status).toBe('skipped');
      dispose();
    });
  });

  describe('error handling', () => {
    it('returns fail when a checkpoint throws', async () => {
      mockChannel.send = vi.fn(async () => {
        throw new Error('Discord API error');
      });
      const cfg = baseConfig();
      const { promptCheckpoint, dispose } = await createAutoCheckpoint(cfg);

      const status = await promptCheckpoint({
        id: 'checkpoint-message-handling',
        label: 'Verify Message Handling',
        instructions: ['Send a probe.'],
      });

      expect(status).toBe('fail');
      // Error should be logged
      const logCalls = (cfg.log as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(logCalls.some((line: string) => line.includes('Discord API error'))).toBe(true);
      dispose();
    });
  });
});

describe('dispose', () => {
  it('destroys the Discord client', async () => {
    const { dispose } = await createAutoCheckpoint(baseConfig());
    dispose();
    expect(mockClientInstance.destroy).toHaveBeenCalledTimes(1);
  });
});
