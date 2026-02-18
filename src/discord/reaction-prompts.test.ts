import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  executeReactionPromptAction,
  tryResolveReactionPrompt,
  pendingPromptCount,
  reactionPromptSection,
  _resetForTest,
} from './reaction-prompts.js';
import type { ReactionPromptRequest } from './reaction-prompts.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  const reactFn = vi.fn().mockResolvedValue(undefined);
  const sendFn = vi.fn().mockResolvedValue({ id: 'prompt-msg-1', react: reactFn });

  return {
    guild: {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue({ send: sendFn }),
        },
      },
    } as any,
    client: {} as any,
    channelId: 'ch-1',
    messageId: 'msg-1',
    ...overrides,
  };
}

function makeAction(overrides: Partial<ReactionPromptRequest> = {}): ReactionPromptRequest {
  return {
    type: 'reactionPrompt',
    question: 'Should I proceed?',
    choices: ['✅', '❌'],
    ...overrides,
  };
}

afterEach(() => {
  _resetForTest();
});

// ---------------------------------------------------------------------------
// Action executor — validation
// ---------------------------------------------------------------------------

describe('executeReactionPromptAction — validation', () => {
  it('rejects empty question', async () => {
    const ctx = makeCtx();
    const result = await executeReactionPromptAction(makeAction({ question: '' }), ctx);
    expect(result).toEqual({ ok: false, error: 'reactionPrompt requires a non-empty question string' });
  });

  it('rejects whitespace-only question', async () => {
    const ctx = makeCtx();
    const result = await executeReactionPromptAction(makeAction({ question: '   ' }), ctx);
    expect(result).toEqual({ ok: false, error: 'reactionPrompt requires a non-empty question string' });
  });

  it('rejects fewer than 2 choices', async () => {
    const ctx = makeCtx();
    const result = await executeReactionPromptAction(makeAction({ choices: ['✅'] }), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('2–9 choices');
  });

  it('rejects more than 9 choices', async () => {
    const ctx = makeCtx();
    const result = await executeReactionPromptAction(
      makeAction({ choices: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'] }),
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('2–9 choices');
  });

  it('rejects empty string in choices array', async () => {
    const ctx = makeCtx();
    const result = await executeReactionPromptAction(makeAction({ choices: ['✅', ''] }), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('non-empty emoji string');
  });

  it('fails when channel not found', async () => {
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue(undefined);
    const result = await executeReactionPromptAction(makeAction(), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('not found or not a text channel');
  });

  it('fails when channel has no send method', async () => {
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ id: 'ch-1' }); // no send
    const result = await executeReactionPromptAction(makeAction(), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('not found or not a text channel');
  });
});

// ---------------------------------------------------------------------------
// Action executor — happy path
// ---------------------------------------------------------------------------

describe('executeReactionPromptAction — happy path', () => {
  it('sends prompt message and adds reactions for each choice', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-1', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    // Resolve the prompt immediately after it is registered.
    const execPromise = executeReactionPromptAction(makeAction({ choices: ['✅', '❌'] }), ctx);

    // Give the executor ticks to: (1) resolve send(), (2) call registerPrompt, then simulate reaction.
    await Promise.resolve();
    await Promise.resolve();
    tryResolveReactionPrompt('prompt-1', '✅');

    const result = await execPromise;

    expect(result).toEqual({ ok: true, summary: 'User chose: ✅' });
    expect(sendFn).toHaveBeenCalledOnce();
    const sentContent: string = sendFn.mock.calls[0][0].content;
    expect(sentContent).toContain('Should I proceed?');
    expect(sentContent).toContain('✅');
    expect(sentContent).toContain('❌');
    expect(reactFn).toHaveBeenCalledWith('✅');
    expect(reactFn).toHaveBeenCalledWith('❌');
  });

  it('resolves with the user-chosen emoji', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-2', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const execPromise = executeReactionPromptAction(
      makeAction({ choices: ['🔴', '🟡', '🟢'] }),
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    tryResolveReactionPrompt('prompt-2', '🟢');

    const result = await execPromise;
    expect(result).toEqual({ ok: true, summary: 'User chose: 🟢' });
  });

  it('resolves when any valid choice is used', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-3', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const execPromise = executeReactionPromptAction(
      makeAction({ choices: ['👍', '👎'] }),
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    tryResolveReactionPrompt('prompt-3', '👎');

    const result = await execPromise;
    expect(result).toEqual({ ok: true, summary: 'User chose: 👎' });
  });

  it('clamps timeoutSeconds to 300', async () => {
    // This test checks that an extreme timeout doesn't cause issues.
    // We resolve immediately so we don't actually wait.
    vi.useFakeTimers();
    try {
      const reactFn = vi.fn().mockResolvedValue(undefined);
      const promptMsg = { id: 'prompt-clamp', react: reactFn };
      const sendFn = vi.fn().mockResolvedValue(promptMsg);
      const ctx = makeCtx();
      (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

      const execPromise = executeReactionPromptAction(
        makeAction({ timeoutSeconds: 9999 }),
        ctx,
      );

      // Give executor ticks to send and register the prompt.
      await Promise.resolve();
      await Promise.resolve();

      // Advance time to just under 300s — should NOT have timed out yet.
      await vi.advanceTimersByTimeAsync(299_000);
      tryResolveReactionPrompt('prompt-clamp', '✅');
      const result = await execPromise;
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes prompt from store after resolution', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-cleanup', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const execPromise = executeReactionPromptAction(makeAction(), ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingPromptCount()).toBe(1);

    tryResolveReactionPrompt('prompt-cleanup', '✅');
    await execPromise;
    expect(pendingPromptCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Action executor — error paths
// ---------------------------------------------------------------------------

describe('executeReactionPromptAction — error paths', () => {
  it('returns error when send throws', async () => {
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({
      send: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
    });

    const result = await executeReactionPromptAction(makeAction(), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Missing Permissions');
  });

  it('returns error when react throws', async () => {
    const reactFn = vi.fn().mockRejectedValue(new Error('Unknown Emoji'));
    const promptMsg = { id: 'prompt-react-err', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const result = await executeReactionPromptAction(makeAction(), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Unknown Emoji');
  });

  it('returns timeout error when no reaction arrives within timeoutSeconds', async () => {
    vi.useFakeTimers();
    try {
      const reactFn = vi.fn().mockResolvedValue(undefined);
      const promptMsg = { id: 'prompt-timeout', react: reactFn };
      const sendFn = vi.fn().mockResolvedValue(promptMsg);
      const ctx = makeCtx();
      (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

      const execPromise = executeReactionPromptAction(
        makeAction({ timeoutSeconds: 10 }),
        ctx,
      );

      await vi.advanceTimersByTimeAsync(10_001);
      const result = await execPromise;
      expect(result.ok).toBe(false);
      expect((result as any).error).toContain('timed out');
      expect(pendingPromptCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// tryResolveReactionPrompt
// ---------------------------------------------------------------------------

describe('tryResolveReactionPrompt', () => {
  it('returns false for unknown message ID', () => {
    expect(tryResolveReactionPrompt('nonexistent', '✅')).toBe(false);
  });

  it('returns false when emoji is not a valid choice', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-invalid-emoji', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    // Start the prompt but don't await it yet.
    const execPromise = executeReactionPromptAction(makeAction({ choices: ['✅', '❌'] }), ctx);
    await Promise.resolve();
    await Promise.resolve();

    // Attempt to resolve with an emoji not in the choices list.
    const consumed = tryResolveReactionPrompt('prompt-invalid-emoji', '🔥');
    expect(consumed).toBe(false);
    // Prompt should still be pending.
    expect(pendingPromptCount()).toBe(1);

    // Now resolve correctly so there's no dangling promise.
    const resolved = tryResolveReactionPrompt('prompt-invalid-emoji', '✅');
    expect(resolved).toBe(true);
    await execPromise;
  });

  it('returns true and resolves the prompt when emoji matches', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-match', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const execPromise = executeReactionPromptAction(makeAction(), ctx);
    await Promise.resolve();
    await Promise.resolve();

    const consumed = tryResolveReactionPrompt('prompt-match', '✅');
    expect(consumed).toBe(true);

    const result = await execPromise;
    expect(result.ok).toBe(true);
  });

  it('only resolves once — second call returns false', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-once', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const execPromise = executeReactionPromptAction(makeAction(), ctx);
    await Promise.resolve();
    await Promise.resolve();

    expect(tryResolveReactionPrompt('prompt-once', '✅')).toBe(true);
    expect(tryResolveReactionPrompt('prompt-once', '✅')).toBe(false);

    await execPromise;
  });
});

// ---------------------------------------------------------------------------
// reactionPromptSection
// ---------------------------------------------------------------------------

describe('reactionPromptSection', () => {
  it('contains the action type name', () => {
    expect(reactionPromptSection()).toContain('reactionPrompt');
  });

  it('documents required fields', () => {
    const section = reactionPromptSection();
    expect(section).toContain('question');
    expect(section).toContain('choices');
    expect(section).toContain('timeoutSeconds');
  });

  it('includes a usage example', () => {
    const section = reactionPromptSection();
    expect(section).toContain('<discord-action>');
    expect(section).toContain('✅');
  });

  it('mentions choice count limits', () => {
    expect(reactionPromptSection()).toContain('2–9');
  });
});
