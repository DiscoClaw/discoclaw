import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReactionPromptStore } from './reaction-prompt-store.js';

const tempDirs: string[] = [];

async function makeStorePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reaction-prompt-store-'));
  tempDirs.push(dir);
  return path.join(dir, 'reaction-prompts.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ReactionPromptStore', () => {
  it('starts empty when the store file does not exist', async () => {
    const store = new ReactionPromptStore(await makeStorePath());
    expect(store.pendingCount()).toBe(0);
  });

  it('persists a pending prompt when registered', async () => {
    const storePath = await makeStorePath();
    const store = new ReactionPromptStore(storePath);

    store.registerPrompt('prompt-1', 'Deploy the build?', ['✅', '❌']);

    expect(store.pendingCount()).toBe(1);
    const raw = await fs.readFile(storePath, 'utf8');
    expect(JSON.parse(raw)).toEqual([
      {
        messageId: 'prompt-1',
        question: 'Deploy the build?',
        choices: ['✅', '❌'],
      },
    ]);
  });

  it('rehydrates pending prompts from disk on startup', async () => {
    const storePath = await makeStorePath();
    const firstStore = new ReactionPromptStore(storePath);
    firstStore.registerPrompt('prompt-restart', 'Ship it?', ['🟢', '🔴']);
    firstStore.resetMemory();

    const restartedStore = new ReactionPromptStore(storePath);

    expect(restartedStore.pendingCount()).toBe(1);
    expect(restartedStore.tryResolvePrompt('prompt-restart', '🟢')).toEqual({
      question: 'Ship it?',
      chosenEmoji: '🟢',
    });
  });

  it('persists removals after a prompt resolves', async () => {
    const storePath = await makeStorePath();
    const store = new ReactionPromptStore(storePath);
    store.registerPrompt('prompt-cleanup', 'Continue?', ['✅', '❌']);

    expect(store.tryResolvePrompt('prompt-cleanup', '❌')).toEqual({
      question: 'Continue?',
      chosenEmoji: '❌',
    });

    const restartedStore = new ReactionPromptStore(storePath);
    expect(restartedStore.pendingCount()).toBe(0);
    const raw = await fs.readFile(storePath, 'utf8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('ignores malformed persisted entries during hydration', async () => {
    const storePath = await makeStorePath();
    await fs.writeFile(
      storePath,
      JSON.stringify([
        { messageId: 'good', question: 'Valid?', choices: ['✅', '❌'] },
        { messageId: '', question: 'missing id', choices: ['✅'] },
        { messageId: 'bad-choices', question: 'bad choices', choices: [] },
        { nope: true },
      ]),
      'utf8',
    );

    const store = new ReactionPromptStore(storePath);

    expect(store.pendingCount()).toBe(1);
    expect(store.tryResolvePrompt('good', '❌')).toEqual({
      question: 'Valid?',
      chosenEmoji: '❌',
    });
  });
});
