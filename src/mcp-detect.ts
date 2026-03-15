import fs from 'node:fs/promises';
import path from 'node:path';

export type McpStdioServerEntry = {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpUrlServerEntry = {
  type: 'url';
  name: string;
  url: string;
  env?: Record<string, string>;
};

export type McpServerEntry = McpStdioServerEntry | McpUrlServerEntry;

export type McpDetectResult =
  | { status: 'found'; servers: McpServerEntry[] }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string };

/**
 * Maximum MCP server name length that avoids exceeding the 200-char API limit for
 * tool_use.name. MCP tool names follow the pattern `mcp__<server>__<tool>`, so
 * 64 chars for the server name leaves 129 chars for the tool name portion.
 */
export const MCP_SERVER_NAME_MAX_LENGTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns warning strings for any server whose name exceeds MCP_SERVER_NAME_MAX_LENGTH.
 * Pure function — no logging side-effects.
 */
export function validateMcpServerNames(servers: McpServerEntry[]): string[] {
  return servers
    .filter((s) => s.name.length > MCP_SERVER_NAME_MAX_LENGTH)
    .map(
      (s) =>
        `MCP server name "${s.name}" is ${s.name.length} chars, exceeding the ${MCP_SERVER_NAME_MAX_LENGTH}-char limit — tool_use.name may exceed the 200-char API limit`,
    );
}

/**
 * Returns warning strings for any server whose env block is present but empty.
 * Pure function — no logging side-effects.
 */
export function validateMcpServerEnv(servers: McpServerEntry[]): string[] {
  return servers
    .filter((s) => s.env !== undefined && Object.keys(s.env).length === 0)
    .map(
      (s) =>
        `MCP server "${s.name}" has an empty env object — likely misconfigured or missing required values`,
    );
}

/**
 * Returns warning strings for env values that appear to rely on shell interpolation.
 * Pure function — no logging side-effects.
 */
export function validateMcpEnvInterpolation(servers: McpServerEntry[]): string[] {
  return servers.flatMap((server) =>
    Object.entries(server.env ?? {})
      .filter(([, envValue]) => envValue.includes('${'))
      .map(
        ([envKey, envValue]) =>
          `MCP server "${server.name}" env "${envKey}" contains uninterpolated placeholder syntax: ${envValue}`,
      ),
  );
}

function formatMcpServerName(server: McpServerEntry): string {
  return server.type === 'url' ? `${server.name} (url)` : server.name;
}

/**
 * Detect MCP servers configured in the workspace `.mcp.json` file.
 * Returns structured info for startup health logging.
 */
export async function detectMcpServers(workspaceCwd: string): Promise<McpDetectResult> {
  const mcpPath = path.join(workspaceCwd, '.mcp.json');

  let raw: string;
  try {
    raw = await fs.readFile(mcpPath, 'utf-8');
  } catch {
    return { status: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'invalid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', reason: 'root must be an object' };
  }

  const obj = parsed as Record<string, unknown>;
  const mcpServers = obj.mcpServers;

  if (mcpServers === undefined) {
    return { status: 'invalid', reason: 'missing "mcpServers" key' };
  }

  if (typeof mcpServers !== 'object' || mcpServers === null || Array.isArray(mcpServers)) {
    return { status: 'invalid', reason: '"mcpServers" must be an object' };
  }

  const entries = Object.entries(mcpServers as Record<string, unknown>);
  const servers: McpServerEntry[] = [];

  for (const [name, value] of entries) {
    if (!isPlainObject(value)) {
      return { status: 'invalid', reason: `server "${name}" must be an object` };
    }
    const entry = value;
    let server: McpServerEntry;
    if (typeof entry.command === 'string' && entry.command) {
      server = { type: 'stdio', name, command: entry.command };
      if (Array.isArray(entry.args)) {
        server.args = entry.args.filter((a): a is string => typeof a === 'string');
      }
    } else if (typeof entry.url === 'string' && entry.url) {
      server = { type: 'url', name, url: entry.url };
    } else {
      return { status: 'invalid', reason: `server "${name}" missing "command"` };
    }
    if (entry.env !== undefined) {
      if (!isPlainObject(entry.env)) {
        return { status: 'invalid', reason: `server "${name}" field "env" must be an object` };
      }

      const env: Record<string, string> = {};
      for (const [envKey, envValue] of Object.entries(entry.env)) {
        if (typeof envValue !== 'string') {
          return {
            status: 'invalid',
            reason: `server "${name}" field "env.${envKey}" must be a string`,
          };
        }
        env[envKey] = envValue;
      }
      server.env = env;
    }
    servers.push(server);
  }

  return { status: 'found', servers };
}

/**
 * Log MCP detection results at startup.
 */
export function logMcpDetection(
  result: McpDetectResult,
  context: { claudeInUse: boolean; strictMcpConfig: boolean },
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  },
): void {
  switch (result.status) {
    case 'missing':
      log.info({}, 'mcp: no .mcp.json found — MCP servers not configured');
      break;
    case 'invalid':
      if (context.strictMcpConfig) {
        log.error({ reason: result.reason }, 'mcp: .mcp.json is invalid — MCP servers will not load');
      } else {
        log.warn({ reason: result.reason }, 'mcp: .mcp.json is invalid — MCP servers will not load');
      }
      break;
    case 'found': {
      const names = result.servers.map(formatMcpServerName);
      const warnings = [
        ...validateMcpServerNames(result.servers),
        ...validateMcpServerEnv(result.servers),
        ...validateMcpEnvInterpolation(result.servers),
      ];
      if (names.length === 0) {
        log.info({}, 'mcp: .mcp.json found but no servers configured');
      } else {
        let msg = `mcp: ${names.length} server${names.length === 1 ? '' : 's'} configured: ${names.join(', ')}`;
        if (!context.claudeInUse) {
          msg += ' (MCP servers only active with Claude runtime)';
        }
        log.info(
          { count: names.length, servers: names, strictMcpConfig: context.strictMcpConfig },
          msg,
        );
      }
      for (const warning of warnings) {
        log.warn({}, warning);
      }
      break;
    }
  }
}
