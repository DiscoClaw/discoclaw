import { describe, expect, it, vi } from 'vitest';
import { createStatusPoster, formatVersionLine, sanitizeErrorMessage, sanitizePhaseError, toBootReportMcpStatus } from './status-channel.js';

function mockChannel() {
  return { send: vi.fn().mockResolvedValue(undefined) } as any;
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function sentContent(ch: ReturnType<typeof mockChannel>, callIndex = 0): string {
  const arg = ch.send.mock.calls[callIndex][0] as { content: string; allowedMentions: unknown };
  return arg.content;
}

describe('createStatusPoster', () => {
  it('online() sends a plain text Bot Online message', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.online();
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Bot Online**');
    expect(msg).toContain('connected and ready');
  });

  it('online() suppresses mentions via NO_MENTIONS', async () => {
    const ch = mockChannel();
    await createStatusPoster(ch).online();
    const arg = ch.send.mock.calls[0][0] as { allowedMentions: unknown };
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  it('offline() sends a plain text Bot Offline message', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.offline();
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Bot Offline**');
    expect(msg).toContain('shutting down');
  });

  it('runtimeError() sends plain text with session and channel context', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.runtimeError({ sessionKey: 'dm:123', channelName: 'general' }, 'timeout');
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Runtime Error**');
    expect(msg).toContain('dm:123');
    expect(msg).toContain('general');
    expect(msg).toContain('timeout');
  });

  it('handlerError() sends plain text with error content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.handlerError({ sessionKey: 'g:1:c:2' }, new Error('boom'));
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Handler Failure**');
    expect(msg).toContain('boom');
  });

  it('handlerError() sanitizes messages containing prompt content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    const leakyErr = new Error('Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful assistant..."');
    await poster.handlerError({ sessionKey: 'g:1:c:2' }, leakyErr);
    const msg = sentContent(ch);
    expect(msg).not.toContain('claude -p');
    expect(msg).toContain('SIGKILL');
  });

  it('actionFailed() sends plain text with action type and error', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.actionFailed('channelCreate', 'Missing perms');
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Action Failed**');
    expect(msg).toContain('channelCreate');
    expect(msg).toContain('Missing perms');
  });

  it('taskSyncComplete() sends plain text with non-zero fields only', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 1, emojisUpdated: 0, starterMessagesUpdated: 2, threadsArchived: 3, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Task Sync Complete**');
    expect(msg).toContain('Created: 1');
    expect(msg).toContain('Starters Updated: 2');
    expect(msg).toContain('Archived: 3');
    expect(msg).not.toContain('Names Updated');
    expect(msg).not.toContain('Statuses Fixed');
    expect(msg).not.toContain('Warnings');
  });

  it('taskSyncComplete() includes warnings when > 0', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 2,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Task Sync Complete**');
    expect(msg).toContain('Warnings: 2');
  });

  it('taskSyncComplete() includes all non-zero counters and warnings together', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 2, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 1, statusesUpdated: 0, tagsUpdated: 0, warnings: 1,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('Created: 2');
    expect(msg).toContain('Archived: 1');
    expect(msg).toContain('Warnings: 1');
  });

  it('taskSyncComplete() is silent when all counters and warnings are zero', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
    });
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('runtimeError() sanitizes messages containing prompt content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    const leakyMsg = 'Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful assistant called Weston..."';
    await poster.runtimeError({ sessionKey: 'dm:123' }, leakyMsg);
    const msg = sentContent(ch);
    expect(msg).toContain('Command was killed with SIGKILL (Forced termination)');
    expect(msg).not.toContain('claude -p');
  });

  it('does not throw when channel.send fails', async () => {
    const ch = { send: vi.fn().mockRejectedValue(new Error('network')) } as any;
    const log = mockLog();
    const poster = createStatusPoster(ch, { log });
    await expect(poster.online()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('bootReport', () => {
  const baseData = {
    startupType: 'first-boot' as const,
    tasksEnabled: false,
    forumResolved: false,
    cronsEnabled: false,
    memoryEpisodicOn: false,
    memorySemanticOn: false,
    memoryWorkingOn: false,
    memoryColdOn: false,
    actionCategoriesEnabled: [] as string[],
  };

  it('includes Credentials line when credentialReport is provided', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, credentialReport: 'discord-token: ok, openai-key: skip' });
    const msg = sentContent(ch);
    expect(msg).toContain('Credentials · discord-token: ok, openai-key: skip');
  });

  it('omits Credentials line when credentialReport is absent', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData });
    const msg = sentContent(ch);
    expect(msg).not.toContain('Credentials');
  });

  it('includes FAIL in the Credentials line when a check failed', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({
      ...baseData,
      credentialReport: 'discord-token: FAIL (invalid or revoked token (401)), openai-key: skip',
    });
    const msg = sentContent(ch);
    expect(msg).toContain('Credentials · discord-token: FAIL (invalid or revoked token (401)), openai-key: skip');
  });

  it('formats Permissions as "ok (tier)" when permissionsStatus is ok', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, permissionsStatus: 'ok', permissionsTier: 'full' });
    const msg = sentContent(ch);
    expect(msg).toContain('Permissions · ok (full)');
  });

  it('formats Permissions as "missing" when permissionsStatus is missing', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, permissionsStatus: 'missing' });
    const msg = sentContent(ch);
    expect(msg).toContain('Permissions · missing');
  });

  it('formats Permissions as "INVALID (reason)" when permissionsStatus is invalid with reason', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, permissionsStatus: 'invalid', permissionsReason: 'invalid tier: "godmode"' });
    const msg = sentContent(ch);
    expect(msg).toContain('Permissions · INVALID (invalid tier: "godmode")');
  });

  it('formats Permissions as "INVALID" without parentheses when no reason is provided', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, permissionsStatus: 'invalid' });
    const msg = sentContent(ch);
    expect(msg).toContain('Permissions · INVALID');
    expect(msg).not.toContain('(undefined');
  });

  it('falls back to tier label when permissionsStatus is absent', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, permissionsTier: 'standard' });
    const msg = sentContent(ch);
    expect(msg).toContain('Permissions · standard');
  });

  it('renders MCP server names when MCP servers are found', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({
      ...baseData,
      mcpStatus: {
        status: 'found',
        servers: [
          { name: 'filesystem', type: 'stdio' },
          { name: 'brave-search', type: 'stdio' },
          { name: 'remote-db', type: 'url' },
        ],
      },
    });
    const msg = sentContent(ch);
    expect(msg).toContain('MCP · 3 servers (filesystem, brave-search, remote-db (url))');
  });

  it('renders "none" when MCP config is missing', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({
      ...baseData,
      mcpStatus: { status: 'missing' },
    });
    const msg = sentContent(ch);
    expect(msg).toContain('MCP · none');
  });

  it('renders the invalid MCP reason when config is invalid', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({
      ...baseData,
      mcpStatus: { status: 'invalid', reason: 'missing "mcpServers" key' },
    });
    const msg = sentContent(ch);
    expect(msg).toContain('MCP · invalid config (missing "mcpServers" key)');
  });

  it('appends MCP warning count when warnings are present', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({
      ...baseData,
      mcpStatus: {
        status: 'found',
        servers: [{ name: 'filesystem', type: 'stdio' }],
      },
      mcpWarnings: 2,
    });
    const msg = sentContent(ch);
    expect(msg).toContain('MCP · 1 server (filesystem) · 2 warnings');
  });

  it('shows "(latest)" when npmVersion equals npmLatestVersion', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, npmVersion: '0.5.8', npmLatestVersion: '0.5.8', buildVersion: 'abc1234' });
    const msg = sentContent(ch);
    expect(msg).toContain('Version · DiscoClaw v0.5.8 (latest) · abc1234');
  });

  it('shows update arrow when npmLatestVersion differs from npmVersion', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, npmVersion: '0.5.8', npmLatestVersion: '0.5.9', buildVersion: 'abc1234' });
    const msg = sentContent(ch);
    expect(msg).toContain('Version · DiscoClaw v0.5.8 → v0.5.9 available · abc1234');
  });

  it('shows version without status when npmLatestVersion is null (registry unreachable)', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, npmVersion: '0.5.8', npmLatestVersion: null, buildVersion: 'abc1234' });
    const msg = sentContent(ch);
    expect(msg).toContain('Version · DiscoClaw v0.5.8 · abc1234');
    expect(msg).not.toContain('latest');
    expect(msg).not.toContain('available');
  });

  it('falls back to git hash only when npmVersion is absent', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, buildVersion: 'abc1234' });
    const msg = sentContent(ch);
    expect(msg).toContain('Version · DiscoClaw abc1234');
  });

  it('shows "(unknown)" when neither npmVersion nor buildVersion is present', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData });
    const msg = sentContent(ch);
    expect(msg).toContain('Version · DiscoClaw (unknown)');
  });

  it('includes Dashboard line when dashboardUrl is provided', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, dashboardUrl: 'http://127.0.0.1:9401/' });
    const msg = sentContent(ch);
    expect(msg).toContain('Dashboard · http://127.0.0.1:9401/');
    expect(msg.indexOf('Dashboard · http://127.0.0.1:9401/')).toBeLessThan(msg.indexOf('Model · (default)'));
  });

  it('omits Dashboard line when dashboardUrl is absent', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData });
    const msg = sentContent(ch);
    expect(msg).not.toContain('Dashboard ·');
  });

  it('includes cold in Memory line when memoryColdOn is true with chunk count', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, memoryColdOn: true, memoryColdChunks: 42 });
    const msg = sentContent(ch);
    expect(msg).toContain('Memory · cold (42 chunks)');
  });

  it('includes cold in Memory line without chunk count when memoryColdChunks is omitted', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, memoryColdOn: true });
    const msg = sentContent(ch);
    expect(msg).toContain('Memory · cold');
    expect(msg).not.toContain('chunks');
  });

  it('lists cold alongside other memory layers', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, memoryEpisodicOn: true, memorySemanticOn: true, memoryColdOn: true, memoryColdChunks: 100 });
    const msg = sentContent(ch);
    expect(msg).toContain('Memory · episodic, semantic, cold (100 chunks)');
  });

  it('omits cold from Memory line when memoryColdOn is false', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.bootReport!({ ...baseData, memoryColdOn: false });
    const msg = sentContent(ch);
    expect(msg).toContain('Memory · off');
    expect(msg).not.toContain('cold');
  });
});

describe('toBootReportMcpStatus', () => {
  it('strips MCP server internals before surfacing boot status', () => {
    const result = toBootReportMcpStatus({
      status: 'found',
      servers: [
        {
          type: 'stdio',
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { API_TOKEN: 'secret' },
        },
        {
          type: 'url',
          name: 'remote-db',
          url: 'https://example.com/mcp',
          env: { API_TOKEN: 'secret' },
        },
      ],
    });

    expect(result).toEqual({
      status: 'found',
      servers: [
        { name: 'filesystem', type: 'stdio' },
        { name: 'remote-db', type: 'url' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('"command":');
    expect(JSON.stringify(result)).not.toContain('"args":');
    expect(JSON.stringify(result)).not.toContain('"env":');
    expect(JSON.stringify(result)).not.toContain('"url":');
  });
});

describe('formatVersionLine', () => {
  it('shows version with (latest) and git hash', () => {
    expect(formatVersionLine({ npmVersion: '1.0.0', npmLatestVersion: '1.0.0', buildVersion: 'abc1234' }))
      .toBe('v1.0.0 (latest) · abc1234');
  });

  it('shows update available with git hash', () => {
    expect(formatVersionLine({ npmVersion: '1.0.0', npmLatestVersion: '1.1.0', buildVersion: 'abc1234' }))
      .toBe('v1.0.0 → v1.1.0 available · abc1234');
  });

  it('shows version without status when latest is null', () => {
    expect(formatVersionLine({ npmVersion: '1.0.0', npmLatestVersion: null, buildVersion: 'abc1234' }))
      .toBe('v1.0.0 · abc1234');
  });

  it('shows version without status when latest is undefined', () => {
    expect(formatVersionLine({ npmVersion: '1.0.0', buildVersion: 'abc1234' }))
      .toBe('v1.0.0 · abc1234');
  });

  it('shows version alone when no git hash', () => {
    expect(formatVersionLine({ npmVersion: '1.0.0', npmLatestVersion: '1.0.0' }))
      .toBe('v1.0.0 (latest)');
  });

  it('shows git hash alone when no npm version', () => {
    expect(formatVersionLine({ buildVersion: 'abc1234' }))
      .toBe('abc1234');
  });

  it('returns (unknown) when nothing is provided', () => {
    expect(formatVersionLine({})).toBe('(unknown)');
  });
});

describe('sanitizeErrorMessage', () => {
  it('passes through short clean messages unchanged', () => {
    expect(sanitizeErrorMessage('timeout')).toBe('timeout');
  });

  it('returns "(no message)" for empty/falsy input', () => {
    expect(sanitizeErrorMessage('')).toBe('(no message)');
  });

  it('strips prompt after "Command was killed with SIGKILL": claude -p ...', () => {
    const msg = 'Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful..."';
    expect(sanitizeErrorMessage(msg)).toBe('Command was killed with SIGKILL (Forced termination)');
  });

  it('strips prompt after "Command failed with exit code 1": claude -p ...', () => {
    const msg = 'Command failed with exit code 1: claude -p "big prompt here..."';
    expect(sanitizeErrorMessage(msg)).toBe('Command failed with exit code 1');
  });

  it('strips content when "claude -p" appears mid-message without colon-space separator', () => {
    const msg = 'Something went wrong while running claude -p "giant prompt"';
    expect(sanitizeErrorMessage(msg)).toBe('Something went wrong while running');
  });

  it('strips prompt with absolute binary path and positional arg (double quotes)', () => {
    const msg = 'Command was killed with SIGKILL (Forced termination): /usr/local/bin/claude --tools bash -- "You are a helpful assistant..."';
    expect(sanitizeErrorMessage(msg)).toBe('Command was killed with SIGKILL (Forced termination)');
  });

  it('strips prompt with absolute binary path and positional arg (single quotes)', () => {
    // execa formats args with single quotes in shortMessage
    const msg = "Command was killed with SIGKILL (Forced termination): /usr/local/bin/claude --tools bash -- 'You are a helpful assistant...'";
    expect(sanitizeErrorMessage(msg)).toBe('Command was killed with SIGKILL (Forced termination)');
  });

  it('strips single-quoted positional prompt when binary name is not "claude"', () => {
    const msg = "Command was killed with SIGKILL (Forced termination): /opt/mybin --tools bash -- 'You are a helpful assistant...'";
    expect(sanitizeErrorMessage(msg)).not.toContain('You are a helpful');
  });

  it('truncates long messages to 500 chars', () => {
    const long = 'x'.repeat(1000);
    expect(sanitizeErrorMessage(long).length).toBe(500);
  });
});

describe('sanitizePhaseError', () => {
  it('formats timeout using ms from error string when no timeoutMs provided', () => {
    const raw = 'Process timed out after 120000ms';
    expect(sanitizePhaseError('3', raw)).toBe('Phase **3** timed out after 2 minutes');
  });

  it('uses provided timeoutMs over value in error string', () => {
    const raw = 'Process timed out after 60000ms';
    expect(sanitizePhaseError('2', raw, 300000)).toBe('Phase **2** timed out after 5 minutes');
  });

  it('uses singular "minute" when timeout is exactly 1 minute', () => {
    const raw = 'timed out after 60000ms';
    expect(sanitizePhaseError('1', raw)).toBe('Phase **1** timed out after 1 minute');
  });

  it('falls back to seconds when timeout is under 1 minute', () => {
    const raw = 'timed out after 30000ms';
    expect(sanitizePhaseError('1', raw)).toBe('Phase **1** timed out after 30 seconds');
  });

  it('wraps non-timeout errors with "Phase X failed:" prefix', () => {
    const raw = 'Command was killed with SIGKILL (Forced termination): claude -p "You are..."';
    const result = sanitizePhaseError('4', raw);
    expect(result).not.toContain('claude -p');
    expect(result).toContain('SIGKILL');
    expect(result).toMatch(/^Phase \*\*4\*\* failed:/);
  });

  it('truncates output to 500 chars', () => {
    const raw = 'x'.repeat(1000);
    expect(sanitizePhaseError('1', raw).length).toBe(500);
  });

  it('handles case-insensitive timeout pattern', () => {
    const raw = 'Timed Out After 90000ms';
    expect(sanitizePhaseError('5', raw)).toBe('Phase **5** timed out after 2 minutes');
  });
});
