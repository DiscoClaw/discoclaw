import type { RuntimeCapability } from './types.js';

// Raw Codex runtime affordances across grounded transports. These reflect what
// the runtime stack can surface, but not every item is safe to advertise as a
// cross-session guarantee because resumed/bypassed/native turns can inherit
// prior sandbox and workspace state.
export const CODEX_RUNTIME_CAPABILITIES = [
  'streaming_text',
  'sessions',
  'workspace_instructions',
  'tools_exec',
  'tools_fs',
  'tools_web',
  'mcp',
] satisfies readonly RuntimeCapability[];

// Prompt-safe Codex capability profile. Keep this to the least-common-
// denominator guarantees that remain true across fresh, resumed, bypassed, and
// native sessions.
export const ADVERTISED_CODEX_CAPABILITIES = [
  'streaming_text',
  'sessions',
] satisfies readonly RuntimeCapability[];

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

function toCapabilitySet(capabilities: Iterable<RuntimeCapability>): ReadonlySet<RuntimeCapability> {
  return capabilities instanceof Set ? capabilities : new Set(capabilities);
}

export function createAdvertisedCodexCapabilities(
  runtimeCapabilities: Iterable<RuntimeCapability>,
): ReadonlySet<RuntimeCapability> {
  const available = toCapabilitySet(runtimeCapabilities);
  const advertised = new Set<RuntimeCapability>(
    ADVERTISED_CODEX_CAPABILITIES.filter((capability) => available.has(capability)),
  );
  if (available.has('mid_turn_steering')) {
    advertised.add('mid_turn_steering');
  }
  return advertised;
}

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
