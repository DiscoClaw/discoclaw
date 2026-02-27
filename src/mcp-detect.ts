import fs from 'node:fs/promises';
import path from 'node:path';

export type McpServerEntry = {
  name: string;
  command: string;
  args?: string[];
};

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
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'invalid', reason: `server "${name}" must be an object` };
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.command !== 'string' || !entry.command) {
      return { status: 'invalid', reason: `server "${name}" missing "command"` };
    }
    const server: McpServerEntry = { name, command: entry.command };
    if (Array.isArray(entry.args)) {
      server.args = entry.args.filter((a): a is string => typeof a === 'string');
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
  log: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void },
): void {
  switch (result.status) {
    case 'missing':
      log.info({}, 'mcp: no .mcp.json found — MCP servers not configured');
      break;
    case 'invalid':
      log.warn({ reason: result.reason }, 'mcp: .mcp.json is invalid — MCP servers will not load');
      break;
    case 'found': {
      const names = result.servers.map((s) => s.name);
      if (names.length === 0) {
        log.info({}, 'mcp: .mcp.json found but no servers configured');
      } else {
        log.info(
          { count: names.length, servers: names },
          `mcp: ${names.length} server${names.length === 1 ? '' : 's'} configured: ${names.join(', ')}`,
        );
      }
      break;
    }
  }
}
