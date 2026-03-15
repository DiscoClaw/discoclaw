import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectMcpServers,
  logMcpDetection,
  MCP_SERVER_NAME_MAX_LENGTH,
  validateMcpEnvInterpolation,
  validateMcpServerEnv,
  validateMcpServerNames,
} from './mcp-detect.js';

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const strictMcpLogContext = { claudeInUse: true, strictMcpConfig: true };
const relaxedMcpLogContext = { claudeInUse: true, strictMcpConfig: false };

describe('detectMcpServers', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('returns missing when .mcp.json does not exist', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'missing' });
  });

  it('returns invalid for malformed JSON', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), '{ broken', 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'invalid JSON' });
  });

  it('returns invalid when root is not an object', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), '"hello"', 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'root must be an object' });
  });

  it('returns invalid when root is an array', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), '[]', 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'root must be an object' });
  });

  it('returns invalid when mcpServers key is missing', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), '{}', 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'missing "mcpServers" key' });
  });

  it('returns invalid when mcpServers is not an object', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: 42 }), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: '"mcpServers" must be an object' });
  });

  it('returns found with empty servers when mcpServers is empty', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'found', servers: [] });
  });

  it('returns found with server details for valid config', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/docs'],
        },
        'brave-search': {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-server-brave-search'],
          env: { BRAVE_API_KEY: 'key-here' },
        },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({
      status: 'found',
      servers: [
        {
          type: 'stdio',
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user/docs'],
        },
        {
          type: 'stdio',
          name: 'brave-search',
          command: 'npx',
          args: ['-y', '@anthropic/mcp-server-brave-search'],
          env: { BRAVE_API_KEY: 'key-here' },
        },
      ],
    });
  });

  it('preserves env values when they are all strings', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        sequential: {
          command: 'uvx',
          env: {
            API_KEY: 'secret',
            MODE: 'readonly',
          },
        },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({
      status: 'found',
      servers: [
        {
          type: 'stdio',
          name: 'sequential',
          command: 'uvx',
          env: {
            API_KEY: 'secret',
            MODE: 'readonly',
          },
        },
      ],
    });
  });

  it('returns invalid when a server entry is missing command', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        broken: { args: ['--flag'] },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'server "broken" missing "command"' });
  });

  it('returns found for a URL-based server entry', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        hosted: { url: 'https://mcp.example.com/sse', env: { API_KEY: 'secret' } },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({
      status: 'found',
      servers: [
        {
          type: 'url',
          name: 'hosted',
          url: 'https://mcp.example.com/sse',
          env: { API_KEY: 'secret' },
        },
      ],
    });
  });

  it('returns found for mixed stdio and URL server entries', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        hosted: { url: 'https://mcp.example.com/sse' },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({
      status: 'found',
      servers: [
        {
          type: 'stdio',
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        { type: 'url', name: 'hosted', url: 'https://mcp.example.com/sse' },
      ],
    });
  });

  it('returns invalid when a server entry has neither command nor url', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        broken: { args: ['--flag'], env: { MODE: 'test' } },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'server "broken" missing "command"' });
  });

  it('returns invalid when a server entry is not an object', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = { mcpServers: { bad: 'string' } };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'server "bad" must be an object' });
  });

  it('returns invalid when env is not an object', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        brave: {
          command: 'npx',
          env: 'BRAVE_API_KEY=secret',
        },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'server "brave" field "env" must be an object' });
  });

  it('returns invalid when env contains non-string values', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        brave: {
          command: 'npx',
          env: {
            BRAVE_API_KEY: 1234,
          },
        },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({ status: 'invalid', reason: 'server "brave" field "env.BRAVE_API_KEY" must be a string' });
  });

  it('handles server with command only (no args)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-detect-'));
    dirs.push(workspace);
    const config = {
      mcpServers: {
        simple: { command: '/usr/local/bin/mcp-server' },
      },
    };
    await fs.writeFile(path.join(workspace, '.mcp.json'), JSON.stringify(config), 'utf-8');

    const result = await detectMcpServers(workspace);
    expect(result).toEqual({
      status: 'found',
      servers: [{ type: 'stdio', name: 'simple', command: '/usr/local/bin/mcp-server' }],
    });
  });
});

describe('validateMcpServerNames', () => {
  it('returns no warnings for a server name under the limit', () => {
    const servers = [{ type: 'stdio' as const, name: 'short', command: 'npx' }];
    expect(validateMcpServerNames(servers)).toEqual([]);
  });

  it('returns no warnings for a server name at exactly the limit', () => {
    const servers = [
      { type: 'stdio' as const, name: 'a'.repeat(MCP_SERVER_NAME_MAX_LENGTH), command: 'npx' },
    ];
    expect(validateMcpServerNames(servers)).toEqual([]);
  });

  it('returns a warning containing the server name when name exceeds the limit', () => {
    const longName = 'a'.repeat(MCP_SERVER_NAME_MAX_LENGTH + 1);
    const servers = [{ type: 'url' as const, name: longName, url: 'https://mcp.example.com/sse' }];
    const warnings = validateMcpServerNames(servers);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(longName);
  });
});

describe('validateMcpServerEnv', () => {
  it('returns no warnings when env is absent or populated', () => {
    const servers = [
      { type: 'stdio' as const, name: 'filesystem', command: 'npx' },
      { type: 'url' as const, name: 'brave-search', url: 'https://mcp.example.com/sse', env: { BRAVE_API_KEY: 'key-here' } },
    ];
    expect(validateMcpServerEnv(servers)).toEqual([]);
  });

  it('returns a warning for empty env objects', () => {
    const warnings = validateMcpServerEnv([
      { type: 'url' as const, name: 'brave-search', url: 'https://mcp.example.com/sse', env: {} },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('brave-search');
    expect(warnings[0]).toContain('empty env object');
  });
});

describe('validateMcpEnvInterpolation', () => {
  it('returns warnings for env values containing interpolation syntax', () => {
    const warnings = validateMcpEnvInterpolation([
      {
        type: 'stdio',
        name: 'filesystem',
        command: 'npx',
        env: { HOME_DIR: '${HOME}/docs', MODE: 'readonly' },
      },
      {
        type: 'url',
        name: 'hosted',
        url: 'https://mcp.example.com/sse',
        env: { API_KEY: '${HOSTED_API_KEY}' },
      },
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('filesystem');
    expect(warnings[0]).toContain('HOME_DIR');
    expect(warnings[1]).toContain('hosted');
    expect(warnings[1]).toContain('API_KEY');
  });

  it('returns no warnings for plain env values', () => {
    const warnings = validateMcpEnvInterpolation([
      {
        type: 'stdio',
        name: 'filesystem',
        command: 'npx',
        env: { HOME_DIR: '/tmp/docs' },
      },
    ]);

    expect(warnings).toEqual([]);
  });
});

describe('logMcpDetection', () => {
  it('logs info for missing .mcp.json', () => {
    const log = mockLog();
    logMcpDetection({ status: 'missing' }, strictMcpLogContext, log);

    expect(log.info).toHaveBeenCalledWith({}, expect.stringContaining('no .mcp.json found'));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs warn for invalid .mcp.json when strict validation is disabled', () => {
    const log = mockLog();
    logMcpDetection({ status: 'invalid', reason: 'invalid JSON' }, relaxedMcpLogContext, log);

    expect(log.warn).toHaveBeenCalledWith(
      { reason: 'invalid JSON' },
      expect.stringContaining('invalid'),
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs error for invalid .mcp.json when strict validation is enabled', () => {
    const log = mockLog();
    logMcpDetection({ status: 'invalid', reason: 'invalid JSON' }, strictMcpLogContext, log);

    expect(log.error).toHaveBeenCalledWith(
      { reason: 'invalid JSON' },
      expect.stringContaining('invalid'),
    );
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs info for empty servers', () => {
    const log = mockLog();
    logMcpDetection({ status: 'found', servers: [] }, strictMcpLogContext, log);

    expect(log.info).toHaveBeenCalledWith({}, expect.stringContaining('no servers configured'));
  });

  it('logs info with server names and warnings for configured servers', () => {
    const log = mockLog();
    logMcpDetection(
      {
        status: 'found',
        servers: [
          { type: 'stdio', name: 'filesystem', command: 'npx' },
          { type: 'url', name: 'brave-search', url: 'https://mcp.example.com/sse', env: {} },
        ],
      },
      { claudeInUse: false, strictMcpConfig: false },
      log,
    );

    expect(log.info).toHaveBeenCalledWith(
      { count: 2, servers: ['filesystem', 'brave-search (url)'], strictMcpConfig: false },
      expect.stringContaining('2 servers configured: filesystem, brave-search (url) (MCP servers only active with Claude runtime)'),
    );
    expect(log.warn).toHaveBeenCalledWith({}, expect.stringContaining('empty env object'));
  });

  it('uses singular "server" for single server', () => {
    const log = mockLog();
    logMcpDetection(
      { status: 'found', servers: [{ type: 'stdio', name: 'filesystem', command: 'npx' }] },
      strictMcpLogContext,
      log,
    );

    expect(log.info).toHaveBeenCalledWith(
      { count: 1, servers: ['filesystem'], strictMcpConfig: true },
      expect.stringContaining('1 server configured'),
    );
  });
});
