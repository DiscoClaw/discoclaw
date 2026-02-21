import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from './store.js';
import { initTasksForumGuard } from './forum-guard.js';

vi.mock('./thread-cache.js', () => ({
  findTaskByThreadId: vi.fn(),
}));
vi.mock('./discord-sync.js', () => ({
  buildAppliedTagsWithStatus: vi.fn(() => ['tag-closed']),
  buildThreadName: vi.fn(() => '✅ [001] My Task'),
}));

import { findTaskByThreadId } from './thread-cache.js';

function makeClient(botUserId = 'bot-user-1') {
  const listeners: Record<string, Function[]> = {};
  return {
    on: vi.fn((event: string, cb: Function) => {
      (listeners[event] ??= []).push(cb);
    }),
    user: { id: botUserId },
    _listeners: listeners,
  };
}

function makeThread(overrides?: Partial<any>) {
  return {
    id: 'thread-1',
    name: 'Task 1',
    parentId: 'tasks-forum-1',
    ownerId: 'bot-user-1',
    appliedTags: [],
    send: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockResolvedValue(undefined),
    client: { user: { id: 'bot-user-1' } },
    ...overrides,
  };
}

const MOCK_TASK = { id: 'ws-001', title: 'My Task', status: 'closed' };

describe('initTasksForumGuard', () => {
  function setup(botUserId = 'bot-user-1') {
    const client = makeClient(botUserId);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initTasksForumGuard({ client: client as any, forumId: 'tasks-forum-1', log });
    const listeners = client._listeners['threadCreate'] ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    return { listener: listeners[0], log };
  }

  it('rejects manually-created threads with guidance and archives', async () => {
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    await listener(thread);

    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('bd create'));
    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it('allows bot-created threads through without sending or archiving', async () => {
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'bot-user-1' });
    await listener(thread);

    expect(thread.send).not.toHaveBeenCalled();
    expect(thread.setArchived).not.toHaveBeenCalled();
  });

  it('ignores threads from other forums', async () => {
    const { listener } = setup();
    const thread = makeThread({ parentId: 'other-forum', ownerId: 'some-user' });
    await listener(thread);

    expect(thread.send).not.toHaveBeenCalled();
    expect(thread.setArchived).not.toHaveBeenCalled();
  });

  it('handles send failure without preventing archive attempt', async () => {
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    thread.send.mockRejectedValue(new Error('Missing Access'));
    await listener(thread);

    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });
});

describe('initTasksForumGuard threadUpdate', () => {
  function setup(botUserId = 'bot-user-1') {
    const client = makeClient(botUserId);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initTasksForumGuard({ client: client as any, forumId: 'tasks-forum-1', log });
    const listeners = client._listeners['threadUpdate'] ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    return { listener: listeners[0], log };
  }

  it('rejects unarchived manual thread', async () => {
    const { listener } = setup();
    const oldThread = makeThread({ ownerId: 'some-user', archived: true });
    const newThread = makeThread({ ownerId: 'some-user', archived: false });
    await listener(oldThread, newThread);

    expect(newThread.send).toHaveBeenCalledWith(expect.stringContaining('bd create'));
    expect(newThread.setArchived).toHaveBeenCalledWith(true);
  });

  it('allows bot-owned unarchived thread through', async () => {
    const { listener } = setup();
    const oldThread = makeThread({ archived: true });
    const newThread = makeThread({ archived: false });
    await listener(oldThread, newThread);

    expect(newThread.send).not.toHaveBeenCalled();
    expect(newThread.setArchived).not.toHaveBeenCalled();
  });

  it('ignores archive transitions (thread being archived)', async () => {
    const { listener } = setup();
    const oldThread = makeThread({ ownerId: 'some-user', archived: false });
    const newThread = makeThread({ ownerId: 'some-user', archived: true });
    await listener(oldThread, newThread);

    expect(newThread.send).not.toHaveBeenCalled();
  });
});

describe('initTasksForumGuard task-aware re-archive (threadCreate)', () => {
  function setup() {
    const client = makeClient();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initTasksForumGuard({
      client: client as any,
      forumId: 'tasks-forum-1',
      log,
      store: new TaskStore(),
      tagMap: { closed: 'tag-closed' },
    });
    const listener = (client._listeners['threadCreate'] ?? [])[0];
    return { listener, log };
  }

  it('re-archives known task thread without sending rejection message', async () => {
    vi.mocked(findTaskByThreadId).mockReturnValue(MOCK_TASK as any);
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    await listener(thread);

    expect(thread.send).not.toHaveBeenCalled();
    expect(thread.edit).toHaveBeenCalled();
    expect(thread.setName).toHaveBeenCalledWith('✅ [001] My Task');
    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it('falls through to rejection when task lookup returns null', async () => {
    vi.mocked(findTaskByThreadId).mockReturnValue(null);
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    await listener(thread);

    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('bd create'));
    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it('falls through to rejection when task lookup throws', async () => {
    vi.mocked(findTaskByThreadId).mockImplementation(() => { throw new Error('fs error'); });
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    await listener(thread);

    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining('bd create'));
    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it('still archives even when edit throws', async () => {
    vi.mocked(findTaskByThreadId).mockReturnValue(MOCK_TASK as any);
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    thread.edit.mockRejectedValue(new Error('edit failed'));
    await listener(thread);

    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });

  it('still archives even when setName throws', async () => {
    vi.mocked(findTaskByThreadId).mockReturnValue(MOCK_TASK as any);
    const { listener } = setup();
    const thread = makeThread({ ownerId: 'some-user' });
    thread.setName.mockRejectedValue(new Error('setName failed'));
    await listener(thread);

    expect(thread.setArchived).toHaveBeenCalledWith(true);
  });
});

describe('initTasksForumGuard task-aware re-archive (threadUpdate)', () => {
  function setup() {
    const client = makeClient();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    initTasksForumGuard({
      client: client as any,
      forumId: 'tasks-forum-1',
      log,
      store: new TaskStore(),
      tagMap: { closed: 'tag-closed' },
    });
    const listener = (client._listeners['threadUpdate'] ?? [])[0];
    return { listener, log };
  }

  it('re-archives known task thread on unarchive without rejection message', async () => {
    vi.mocked(findTaskByThreadId).mockReturnValue(MOCK_TASK as any);
    const { listener } = setup();
    const oldThread = makeThread({ ownerId: 'some-user', archived: true });
    const newThread = makeThread({ ownerId: 'some-user', archived: false });
    await listener(oldThread, newThread);

    expect(newThread.send).not.toHaveBeenCalled();
    expect(newThread.edit).toHaveBeenCalled();
    expect(newThread.setName).toHaveBeenCalledWith('✅ [001] My Task');
    expect(newThread.setArchived).toHaveBeenCalledWith(true);
  });

  it('falls through to rejection when task not found on threadUpdate', async () => {
    vi.mocked(findTaskByThreadId).mockReturnValue(null);
    const { listener } = setup();
    const oldThread = makeThread({ ownerId: 'some-user', archived: true });
    const newThread = makeThread({ ownerId: 'some-user', archived: false });
    await listener(oldThread, newThread);

    expect(newThread.send).toHaveBeenCalledWith(expect.stringContaining('bd create'));
    expect(newThread.setArchived).toHaveBeenCalledWith(true);
  });
});
