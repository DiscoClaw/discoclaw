import type { RuntimeCapability } from './types.js';

export type CodexCapabilityContract =
  | {
      exposure: 'advertised';
      availability: 'base' | 'conditional';
      runtimeWording: string;
      enforcementGate: string;
    }
  | {
      exposure: 'transport_only';
      availability: 'base' | 'conditional';
      runtimeWording: string;
    };

const CODEX_CAPABILITY_ORDER = [
  'streaming_text',
  'sessions',
  'workspace_instructions',
  'tools_exec',
  'tools_fs',
  'tools_web',
  'mcp',
  'mid_turn_steering',
] as const satisfies readonly RuntimeCapability[];

type CodexKnownCapability = (typeof CODEX_CAPABILITY_ORDER)[number];

// Codex can surface richer grounded transport state than it can safely promise
// across fresh, resumed, bypassed, and native turns. Any capability exposed as
// a retained guarantee must name the enforcement gate that keeps the contract
// true; everything else is downgraded to non-guaranteed runtime wording.
export const CODEX_CAPABILITY_CONTRACT: Readonly<Record<CodexKnownCapability, CodexCapabilityContract>> = {
  streaming_text: {
    exposure: 'advertised',
    availability: 'base',
    runtimeWording: 'Streams reply text through the RuntimeAdapter event channel.',
    enforcementGate: 'createCliRuntime: RuntimeAdapter.invoke emits EngineEvent text output',
  },
  sessions: {
    exposure: 'advertised',
    availability: 'base',
    runtimeWording: 'Supports retained Codex sessions when the runtime advertises sessions.',
    enforcementGate: 'createCliRuntime: disableSessions removes the sessions capability and session map',
  },
  workspace_instructions: {
    exposure: 'transport_only',
    availability: 'base',
    runtimeWording:
      'Grounded Codex turns may inherit workspace instructions from transport or session state, but that is not guaranteed across resumed, bypassed, or native turns.',
  },
  tools_exec: {
    exposure: 'transport_only',
    availability: 'base',
    runtimeWording:
      'Grounded Codex turns may surface command execution tools, but that is not guaranteed across resumed, bypassed, or native turns.',
  },
  tools_fs: {
    exposure: 'transport_only',
    availability: 'base',
    runtimeWording:
      'Grounded Codex turns may surface file-system tools, but that is not guaranteed across resumed, bypassed, or native turns.',
  },
  tools_web: {
    exposure: 'transport_only',
    availability: 'base',
    runtimeWording:
      'Grounded Codex turns may surface web tools, but that is not guaranteed across resumed, bypassed, or native turns.',
  },
  mcp: {
    exposure: 'transport_only',
    availability: 'base',
    runtimeWording:
      'Grounded Codex turns may surface MCP tools, but that is not guaranteed across resumed, bypassed, or native turns.',
  },
  mid_turn_steering: {
    exposure: 'advertised',
    availability: 'conditional',
    runtimeWording: 'Supports mid-turn steer and interrupt when the native app-server path is active.',
    enforcementGate:
      'createCodexCliRuntime: app-server native gating adds mid_turn_steering only when steer/interrupt are wired',
  },
};

function collectCodexCapabilities(
  predicate: (capability: CodexKnownCapability, contract: CodexCapabilityContract) => boolean,
): RuntimeCapability[] {
  return CODEX_CAPABILITY_ORDER.filter((capability) =>
    predicate(capability, CODEX_CAPABILITY_CONTRACT[capability]));
}

// Raw Codex runtime affordances across grounded transports. These reflect what
// the runtime stack can surface, including non-guaranteed transport-only
// surfaces that should not be advertised as stable contracts.
export const CODEX_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = collectCodexCapabilities(
  (_capability, contract) => contract.availability === 'base',
);

// Prompt-safe Codex capability profile. Keep this to the least-common-
// denominator guarantees that remain true across fresh, resumed, bypassed, and
// native sessions and that name an enforcement gate in code.
export const ADVERTISED_CODEX_CAPABILITIES: readonly RuntimeCapability[] = collectCodexCapabilities(
  (_capability, contract) => contract.availability === 'base' && contract.exposure === 'advertised',
);

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

function isCodexKnownCapability(capability: RuntimeCapability): capability is CodexKnownCapability {
  return Object.prototype.hasOwnProperty.call(CODEX_CAPABILITY_CONTRACT, capability);
}

export function getCodexCapabilityContract(
  capability: RuntimeCapability,
): CodexCapabilityContract | undefined {
  return isCodexKnownCapability(capability)
    ? CODEX_CAPABILITY_CONTRACT[capability]
    : undefined;
}

export function createAdvertisedCodexCapabilities(
  runtimeCapabilities: Iterable<RuntimeCapability>,
): ReadonlySet<RuntimeCapability> {
  const available = toCapabilitySet(runtimeCapabilities);
  const advertised = new Set<RuntimeCapability>();

  for (const capability of available) {
    const contract = getCodexCapabilityContract(capability);
    if (contract?.exposure === 'advertised') {
      advertised.add(capability);
    }
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
