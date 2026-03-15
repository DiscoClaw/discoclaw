import { describe, expect, it } from 'vitest';
import { handleMcpCommand, isMcpCommandPrefix, parseMcpCommand } from './mcp-command.js';

describe('parseMcpCommand', () => {
  it('parses supported command forms', () => {
    expect(parseMcpCommand('!mcp')).toEqual({ action: 'list' });
    expect(parseMcpCommand('!mcp list')).toEqual({ action: 'list' });
    expect(parseMcpCommand('!mcp help')).toEqual({ action: 'help' });
  });

  it('normalizes case and whitespace', () => {
    expect(parseMcpCommand('  !MCP  ')).toEqual({ action: 'list' });
    expect(parseMcpCommand('\n!Mcp\tList  ')).toEqual({ action: 'list' });
    expect(parseMcpCommand(' !mCp HeLp ')).toEqual({ action: 'help' });
  });

  it('returns null for unsupported subcommands and unrelated input', () => {
    expect(parseMcpCommand('!mcp status')).toBeNull();
    expect(parseMcpCommand('!mcp list now')).toBeNull();
    expect(parseMcpCommand('!mcps')).toBeNull();
    expect(parseMcpCommand('!status')).toBeNull();
    expect(parseMcpCommand('hello')).toBeNull();
  });
});

describe('isMcpCommandPrefix', () => {
  it('matches the !mcp command family', () => {
    expect(isMcpCommandPrefix('!mcp')).toBe(true);
    expect(isMcpCommandPrefix('!MCP list')).toBe(true);
    expect(isMcpCommandPrefix('  !mcp unknown')).toBe(true);
  });

  it('does not match prefix collisions', () => {
    expect(isMcpCommandPrefix('!mcps')).toBe(false);
    expect(isMcpCommandPrefix('!mcpserver')).toBe(false);
    expect(isMcpCommandPrefix('hello !mcp')).toBe(false);
  });
});

describe('handleMcpCommand', () => {
  it('renders help text', () => {
    const out = handleMcpCommand(
      { action: 'help' },
      { mcpStatus: undefined, mcpWarnings: 0 },
    );

    expect(out).toContain('!mcp commands');
    expect(out).toContain('!mcp list');
    expect(out).toContain('!mcp help');
  });

  it('renders unavailable status when boot snapshot is missing', () => {
    const out = handleMcpCommand(
      { action: 'list' },
      { mcpStatus: undefined, mcpWarnings: 0 },
    );

    expect(out).toMatch(/^```text\n/);
    expect(out).toContain('State: unavailable');
    expect(out).toContain('Server count: unknown');
    expect(out).toContain('Validation warnings: unknown');
  });

  it('renders configured MCP servers and warning count', () => {
    const out = handleMcpCommand(
      { action: 'list' },
      {
        mcpStatus: {
          status: 'found',
          servers: [
            { name: 'filesystem', type: 'stdio' },
            { name: 'remote-db', type: 'url' },
          ],
        },
        mcpWarnings: 2,
      },
    );

    expect(out).toContain('State: configured');
    expect(out).toContain('Server count: 2');
    expect(out).toContain('Validation warnings: 2');
    expect(out).toContain('- filesystem: stdio');
    expect(out).toContain('- remote-db: url');
  });

  it('renders configured state with no listed servers', () => {
    const out = handleMcpCommand(
      { action: 'list' },
      {
        mcpStatus: { status: 'found', servers: [] },
        mcpWarnings: 0,
      },
    );

    expect(out).toContain('State: configured');
    expect(out).toContain('Server count: 0');
    expect(out).toContain('Validation warnings: none');
    expect(out).toContain('Servers: none');
  });

  it('renders missing MCP config', () => {
    const out = handleMcpCommand(
      { action: 'list' },
      {
        mcpStatus: { status: 'missing' },
        mcpWarnings: 0,
      },
    );

    expect(out).toContain('State: missing');
    expect(out).toContain('Server count: 0');
    expect(out).toContain('Details: MCP not configured.');
  });

  it('renders invalid MCP config', () => {
    const out = handleMcpCommand(
      { action: 'list' },
      {
        mcpStatus: { status: 'invalid', reason: 'missing \"mcpServers\" key' },
        mcpWarnings: 1,
      },
    );

    expect(out).toContain('State: invalid');
    expect(out).toContain('Validation warnings: 1');
    expect(out).toContain('Details: Invalid MCP config: missing \"mcpServers\" key');
  });
});
