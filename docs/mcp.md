# MCP (Model Context Protocol)

MCP lets you connect external tool servers to your DiscoClaw instance. When the Claude runtime starts, it reads your `.mcp.json` file and connects to any configured servers, making their tools available during conversations.

## How it works

DiscoClaw passes `--strict-mcp-config` to Claude by default (controlled by `CLAUDE_STRICT_MCP_CONFIG=1` in `.env`). This tells Claude to only use MCP servers defined in your config file and skip auto-discovery, which avoids slow startup in headless/systemd contexts.

MCP is only supported by the **Claude** runtime adapter. Other adapters (OpenAI, OpenRouter, Gemini, Codex) do not use MCP.

## Configuration

Place a `.mcp.json` file in your workspace directory (the directory pointed to by `WORKSPACE_CWD`, which defaults to `./workspace` or `$DISCOCLAW_DATA_DIR/workspace`).

### Format

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<path-to-binary>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "API_KEY": "your-key-here"
      }
    }
  }
}
```

### Fields

- `command` (required): Path to the MCP server binary or script.
- `args` (optional): Array of command-line arguments.
- `env` (optional): Environment variables passed to the server process.

### Example

A filesystem MCP server that gives your assistant read access to a specific directory:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"]
    }
  }
}
```

A Brave Search MCP server:

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_STRICT_MCP_CONFIG` | `1` | When enabled, Claude only loads MCP servers from your config file. Disable (`0`) to allow auto-discovery. |

## Server name length limit

MCP tools exposed to Claude follow the naming pattern `mcp__<server>__<tool>`. The Anthropic API enforces a **200-character limit** on `tool_use.name` blocks in conversation history. To stay safely within that limit, **server names must be ≤ 64 characters**.

If a server name is too long, DiscoClaw will log a warning at startup:

```
mcp: MCP server name "my-very-long-server-name..." is 70 chars, exceeding the 64-char limit
```

If the API error still occurs at runtime, the error message will direct you here rather than showing a raw API dump.

**Rule of thumb:** keep server names short and descriptive (e.g. `fs`, `brave-search`, `image-gen`).

## Troubleshooting

- **MCP servers not loading:** Verify `.mcp.json` is in your workspace directory and is valid JSON. Check startup logs for MCP-related errors.
- **Slow startup:** An MCP server that takes too long to initialize can delay the first response. Check server health independently before adding it to your config.
- **Server crashes:** MCP server failures don't crash DiscoClaw — the runtime continues without the failed server's tools. Check logs for connection errors.
- **`tool_use.name` API 400 error:** An MCP server name exceeds 64 chars. Rename it in `workspace/.mcp.json`. See [Server name length limit](#server-name-length-limit) above.
