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
