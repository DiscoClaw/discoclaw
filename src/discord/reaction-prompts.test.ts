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
  it('sends prompt message with question text only and adds reactions', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-1', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const result = await executeReactionPromptAction(makeAction({ choices: ['✅', '❌'] }), ctx);

    expect(result).toEqual({ ok: true, summary: 'Prompt sent — awaiting user reaction' });
    expect(sendFn).toHaveBeenCalledOnce();
    const sentContent: string = sendFn.mock.calls[0][0].content;
    expect(sentContent).toBe('Should I proceed?');
    expect(reactFn).toHaveBeenCalledWith('✅');
    expect(reactFn).toHaveBeenCalledWith('❌');
  });

  it('registers prompt data accessible via tryResolveReactionPrompt', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-2', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    await executeReactionPromptAction(makeAction({ choices: ['🔴', '🟡', '🟢'] }), ctx);

    const resolved = tryResolveReactionPrompt('prompt-2', '🟢');
    expect(resolved).toEqual({ question: 'Should I proceed?', chosenEmoji: '🟢' });
  });

  it('accepts any valid emoji choice', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-3', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const result = await executeReactionPromptAction(makeAction({ choices: ['👍', '👎'] }), ctx);
    expect(result).toEqual({ ok: true, summary: 'Prompt sent — awaiting user reaction' });

    const resolved = tryResolveReactionPrompt('prompt-3', '👎');
    expect(resolved).toEqual({ question: 'Should I proceed?', chosenEmoji: '👎' });
  });

  it('accepts timeoutSeconds without error (field is ignored)', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-clamp', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const result = await executeReactionPromptAction(makeAction({ timeoutSeconds: 9999 }), ctx);
    expect(result).toEqual({ ok: true, summary: 'Prompt sent — awaiting user reaction' });
  });

  it('removes prompt from store after resolution via tryResolveReactionPrompt', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-cleanup', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const result = await executeReactionPromptAction(makeAction(), ctx);
    expect(result.ok).toBe(true);
    expect(pendingPromptCount()).toBe(1);

    tryResolveReactionPrompt('prompt-cleanup', '✅');
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

  it('returns error when react throws and cleans up pending prompt', async () => {
    const reactFn = vi.fn().mockRejectedValue(new Error('Unknown Emoji'));
    const promptMsg = { id: 'prompt-react-err', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    const result = await executeReactionPromptAction(makeAction(), ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Unknown Emoji');
    expect(pendingPromptCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tryResolveReactionPrompt
// ---------------------------------------------------------------------------

describe('tryResolveReactionPrompt', () => {
  it('returns null for unknown message ID', () => {
    expect(tryResolveReactionPrompt('nonexistent', '✅')).toBeNull();
  });

  it('returns null when emoji is not a valid choice', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-invalid-emoji', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    await executeReactionPromptAction(makeAction({ choices: ['✅', '❌'] }), ctx);

    expect(tryResolveReactionPrompt('prompt-invalid-emoji', '🔥')).toBeNull();
    expect(pendingPromptCount()).toBe(1);

    const resolved = tryResolveReactionPrompt('prompt-invalid-emoji', '✅');
    expect(resolved).toEqual({ question: 'Should I proceed?', chosenEmoji: '✅' });
  });

  it('returns matched data when emoji matches', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-match', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    await executeReactionPromptAction(makeAction(), ctx);

    const result = tryResolveReactionPrompt('prompt-match', '✅');
    expect(result).toEqual({ question: 'Should I proceed?', chosenEmoji: '✅' });
  });

  it('only resolves once — second call returns null', async () => {
    const reactFn = vi.fn().mockResolvedValue(undefined);
    const promptMsg = { id: 'prompt-once', react: reactFn };
    const sendFn = vi.fn().mockResolvedValue(promptMsg);
    const ctx = makeCtx();
    (ctx.guild.channels.cache.get as any).mockReturnValue({ send: sendFn });

    await executeReactionPromptAction(makeAction(), ctx);

    expect(tryResolveReactionPrompt('prompt-once', '✅')).not.toBeNull();
    expect(tryResolveReactionPrompt('prompt-once', '✅')).toBeNull();
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
