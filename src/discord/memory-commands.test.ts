import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseMemoryCommand, handleMemoryCommand } from './memory-commands.js';
import { saveDurableMemory, addItem } from './durable-memory.js';
import type { DurableMemoryStore } from './durable-memory.js';
import { saveSummary } from './summarizer.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-commands-test-'));
}

function baseOpts(overrides: Partial<Parameters<typeof handleMemoryCommand>[1]> = {}) {
  return {
    userId: '12345',
    sessionKey: 'discord:dm:12345',
    durableDataDir: '/tmp/durable',
    durableMaxItems: 200,
    durableInjectMaxChars: 2000,
    summaryDataDir: '/tmp/summaries',
    ...overrides,
  };
}

describe('parseMemoryCommand', () => {
  it('returns null for non-commands', () => {
    expect(parseMemoryCommand('hello world')).toBeNull();
    expect(parseMemoryCommand('!other command')).toBeNull();
    expect(parseMemoryCommand('!memoryshow')).toBeNull();
    expect(parseMemoryCommand('')).toBeNull();
  });

  it('parses !memory show', () => {
    expect(parseMemoryCommand('!memory show')).toEqual({ action: 'show', args: '' });
  });

  it('parses bare !memory as show', () => {
    expect(parseMemoryCommand('!memory')).toEqual({ action: 'show', args: '' });
  });

  it('parses !memory remember foo', () => {
    expect(parseMemoryCommand('!memory remember I prefer TypeScript')).toEqual({
      action: 'remember',
      args: 'I prefer TypeScript',
    });
  });

  it('parses !memory forget bar', () => {
    expect(parseMemoryCommand('!memory forget TypeScript')).toEqual({
      action: 'forget',
      args: 'TypeScript',
    });
  });

  it('parses !memory reset rolling', () => {
    expect(parseMemoryCommand('!memory reset rolling')).toEqual({
      action: 'reset-rolling',
      args: '',
    });
  });

  it('ignores extra whitespace', () => {
    expect(parseMemoryCommand('  !memory   show  ')).toEqual({ action: 'show', args: '' });
    expect(parseMemoryCommand('  !memory   remember   foo bar  ')).toEqual({
      action: 'remember',
      args: 'foo bar',
    });
  });
});

describe('handleMemoryCommand', () => {
  it('show — returns formatted durable + rolling', async () => {
    const durableDir = await makeTmpDir();
    const summaryDir = await makeTmpDir();

    const store: DurableMemoryStore = { version: 1, updatedAt: 0, items: [] };
    addItem(store, 'User prefers TypeScript', { type: 'manual' }, 200);
    await saveDurableMemory(durableDir, '12345', store);
    await saveSummary(summaryDir, 'discord:dm:12345', {
      summary: 'User is working on memory system.',
      updatedAt: Date.now(),
    });

    const result = await handleMemoryCommand(
      { action: 'show', args: '' },
      baseOpts({ durableDataDir: durableDir, summaryDataDir: summaryDir }),
    );
    expect(result).toContain('**Durable memory:**');
    expect(result).toContain('User prefers TypeScript');
    expect(result).toContain('**Rolling summary:**');
    expect(result).toContain('User is working on memory system.');
  });

  it('show — returns "(none)" when empty', async () => {
    const durableDir = await makeTmpDir();
    const summaryDir = await makeTmpDir();

    const result = await handleMemoryCommand(
      { action: 'show', args: '' },
      baseOpts({ durableDataDir: durableDir, summaryDataDir: summaryDir }),
    );
    expect(result).toContain('(none)');
  });

  it('remember — adds item and saves', async () => {
    const durableDir = await makeTmpDir();

    const result = await handleMemoryCommand(
      { action: 'remember', args: 'I prefer dark mode' },
      baseOpts({ durableDataDir: durableDir }),
    );
    expect(result).toBe('Remembered: I prefer dark mode');

    // Verify it was saved to disk.
    const raw = await fs.readFile(path.join(durableDir, '12345.json'), 'utf8');
    const store = JSON.parse(raw) as DurableMemoryStore;
    expect(store.items).toHaveLength(1);
    expect(store.items[0].text).toBe('I prefer dark mode');
  });

  it('forget — deprecates matching items', async () => {
    const durableDir = await makeTmpDir();

    // First remember something
    await handleMemoryCommand(
      { action: 'remember', args: 'TypeScript' },
      baseOpts({ durableDataDir: durableDir }),
    );

    // Then forget it
    const result = await handleMemoryCommand(
      { action: 'forget', args: 'TypeScript' },
      baseOpts({ durableDataDir: durableDir }),
    );
    expect(result).toBe('Forgot 1 item(s).');
  });

  it('forget — reports when no match found', async () => {
    const durableDir = await makeTmpDir();

    const result = await handleMemoryCommand(
      { action: 'forget', args: 'something that does not exist' },
      baseOpts({ durableDataDir: durableDir }),
    );
    expect(result).toBe('No matching items found.');
  });

  it('remember — persists channelId and messageId in source', async () => {
    const durableDir = await makeTmpDir();

    await handleMemoryCommand(
      { action: 'remember', args: 'test fact' },
      baseOpts({ durableDataDir: durableDir, channelId: 'ch42', messageId: 'msg99' }),
    );

    const raw = await fs.readFile(path.join(durableDir, '12345.json'), 'utf8');
    const store = JSON.parse(raw) as DurableMemoryStore;
    expect(store.items[0].source).toEqual({ type: 'manual', channelId: 'ch42', messageId: 'msg99' });
  });

  it('remember persists guildId and channelName in source', async () => {
    const durableDir = await makeTmpDir();

    await handleMemoryCommand(
      { action: 'remember', args: 'test fact' },
      baseOpts({ durableDataDir: durableDir, channelId: 'ch42', messageId: 'msg99', guildId: 'g1', channelName: 'dev' }),
    );

    const raw = await fs.readFile(path.join(durableDir, '12345.json'), 'utf8');
    const store = JSON.parse(raw) as DurableMemoryStore;
    expect(store.items[0].source).toEqual({
      type: 'manual',
      channelId: 'ch42',
      messageId: 'msg99',
      guildId: 'g1',
      channelName: 'dev',
    });
  });

  it('concurrent remember calls serialize correctly', async () => {
    const durableDir = await makeTmpDir();

    // Fire off concurrent remember commands
    const results = await Promise.all([
      handleMemoryCommand(
        { action: 'remember', args: 'fact one' },
        baseOpts({ durableDataDir: durableDir }),
      ),
      handleMemoryCommand(
        { action: 'remember', args: 'fact two' },
        baseOpts({ durableDataDir: durableDir }),
      ),
      handleMemoryCommand(
        { action: 'remember', args: 'fact three' },
        baseOpts({ durableDataDir: durableDir }),
      ),
    ]);

    expect(results).toEqual([
      'Remembered: fact one',
      'Remembered: fact two',
      'Remembered: fact three',
    ]);

    // Verify all three ended up on disk
    const raw = await fs.readFile(path.join(durableDir, '12345.json'), 'utf8');
    const store = JSON.parse(raw) as DurableMemoryStore;
    expect(store.items).toHaveLength(3);
    const texts = store.items.map((it) => it.text).sort();
    expect(texts).toEqual(['fact one', 'fact three', 'fact two']);
  });

  it('reset-rolling — deletes summary file', async () => {
    const summaryDir = await makeTmpDir();
    await saveSummary(summaryDir, 'discord:dm:12345', {
      summary: 'some summary',
      updatedAt: Date.now(),
    });

    const result = await handleMemoryCommand(
      { action: 'reset-rolling', args: '' },
      baseOpts({ summaryDataDir: summaryDir }),
    );
    expect(result).toBe('Rolling summary cleared for this session.');

    // Verify file is gone.
    const files = await fs.readdir(summaryDir);
    expect(files).toHaveLength(0);
  });
});
