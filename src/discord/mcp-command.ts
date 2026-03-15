import type { BootReportMcpStatus } from './status-channel.js';

export type McpCommand = {
  action: 'list' | 'help';
};

export type McpCommandOpts = {
  mcpStatus: BootReportMcpStatus | undefined;
  mcpWarnings: number;
};

type BootReportFoundMcpStatus = Extract<BootReportMcpStatus, { status: 'found' }>;

function renderTextBlock(lines: string[]): string {
  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}

function formatMcpServerType(server: BootReportFoundMcpStatus['servers'][number]): string {
  return server.type === 'url' ? 'url' : 'stdio';
}

export function parseMcpCommand(content: string): McpCommand | null {
  const tokens = String(content ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0]!.toLowerCase() !== '!mcp') return null;

  if (tokens.length === 1) return { action: 'list' };

  const subcommand = tokens[1]!.toLowerCase();
  if (subcommand === 'list' && tokens.length === 2) return { action: 'list' };
  if (subcommand === 'help' && tokens.length === 2) return { action: 'help' };
  return null;
}

export function isMcpCommandPrefix(content: string): boolean {
  return /^!mcp(?:\b|$)/i.test(String(content ?? '').trimStart());
}

export function handleMcpCommand(cmd: McpCommand, opts: McpCommandOpts): string {
  if (cmd.action === 'help') {
    return [
      '**!mcp commands:**',
      '- `!mcp` — show MCP server configuration status',
      '- `!mcp list` — same as above',
      '- `!mcp help` — this message',
    ].join('\n');
  }

  const lines = ['MCP Status'];

  if (!opts.mcpStatus) {
    lines.push('State: unavailable');
    lines.push('Server count: unknown');
    lines.push('Validation warnings: unknown');
    lines.push('Details: MCP status is not yet available.');
    return renderTextBlock(lines);
  }

  switch (opts.mcpStatus.status) {
    case 'found': {
      lines.push('State: configured');
      lines.push(`Server count: ${opts.mcpStatus.servers.length}`);
      lines.push(`Validation warnings: ${opts.mcpWarnings === 0 ? 'none' : opts.mcpWarnings}`);
      if (opts.mcpStatus.servers.length === 0) {
        lines.push('Servers: none');
      } else {
        lines.push('Servers:');
        for (const server of opts.mcpStatus.servers) {
          lines.push(`- ${server.name}: ${formatMcpServerType(server)}`);
        }
      }
      break;
    }
    case 'missing':
      lines.push('State: missing');
      lines.push('Server count: 0');
      lines.push(`Validation warnings: ${opts.mcpWarnings === 0 ? 'none' : opts.mcpWarnings}`);
      lines.push('Details: MCP not configured.');
      break;
    case 'invalid':
      lines.push('State: invalid');
      lines.push('Server count: 0');
      lines.push(`Validation warnings: ${opts.mcpWarnings === 0 ? 'none' : opts.mcpWarnings}`);
      lines.push(`Details: Invalid MCP config: ${opts.mcpStatus.reason}`);
      break;
  }

  return renderTextBlock(lines);
}
