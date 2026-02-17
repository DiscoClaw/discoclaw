import type { RuntimeCapability } from './types.js';

const TOOL_CAPABILITIES: Readonly<Record<string, RuntimeCapability>> = {
  Bash: 'tools_exec',
  Read: 'tools_fs',
  Write: 'tools_fs',
  Edit: 'tools_fs',
  Glob: 'tools_fs',
  Grep: 'tools_fs',
  WebSearch: 'tools_web',
  WebFetch: 'tools_web',
};

export function requiredCapabilityForTool(tool: string): RuntimeCapability | undefined {
  return TOOL_CAPABILITIES[tool];
}

export function filterToolsByCapabilities(
  tools: string[],
  capabilities: ReadonlySet<RuntimeCapability>,
): { tools: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const tool of tools) {
    const required = requiredCapabilityForTool(tool);
    if (!required || capabilities.has(required)) {
      kept.push(tool);
    } else {
      dropped.push(tool);
    }
  }

  return { tools: kept, dropped };
}
