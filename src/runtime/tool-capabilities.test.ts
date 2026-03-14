import { describe, expect, it } from 'vitest';
import type { RuntimeCapability } from './types.js';
import {
  ADVERTISED_CODEX_CAPABILITIES,
  CODEX_CAPABILITY_CONTRACT,
  CODEX_RUNTIME_CAPABILITIES,
  createAdvertisedCodexCapabilities,
  filterToolsByCapabilities,
  getCodexCapabilityContract,
  requiredCapabilityForTool,
} from './tool-capabilities.js';

const COVERED_RUNTIME_CONFIGS = [
  {
    name: 'grounded cli',
    runtimeCapabilities: new Set(CODEX_RUNTIME_CAPABILITIES),
    expectedAdvertised: ['streaming_text', 'sessions'],
  },
  {
    name: 'native app-server',
    runtimeCapabilities: new Set([...CODEX_RUNTIME_CAPABILITIES, 'mid_turn_steering']),
    expectedAdvertised: ['streaming_text', 'sessions', 'mid_turn_steering'],
  },
  {
    name: 'sessions disabled',
    runtimeCapabilities: new Set(CODEX_RUNTIME_CAPABILITIES.filter((capability) => capability !== 'sessions')),
    expectedAdvertised: ['streaming_text'],
  },
] satisfies Array<{
  name: string;
  runtimeCapabilities: ReadonlySet<RuntimeCapability>;
  expectedAdvertised: RuntimeCapability[];
}>;

describe('createAdvertisedCodexCapabilities', () => {
  it('keeps the Codex advertised profile conservative when raw runtime state is richer', () => {
    const advertised = createAdvertisedCodexCapabilities(new Set(CODEX_RUNTIME_CAPABILITIES));

    expect(CODEX_RUNTIME_CAPABILITIES).toContain('tools_fs');
    expect(CODEX_RUNTIME_CAPABILITIES).toContain('tools_exec');
    expect(CODEX_RUNTIME_CAPABILITIES).toContain('tools_web');
    expect(CODEX_RUNTIME_CAPABILITIES).toContain('workspace_instructions');
    expect(CODEX_RUNTIME_CAPABILITIES).toContain('mcp');
    expect([...advertised].sort()).toEqual([...ADVERTISED_CODEX_CAPABILITIES].sort());
  });

  it.each(COVERED_RUNTIME_CONFIGS)(
    'matches the enforcement-backed contract for $name',
    ({ runtimeCapabilities, expectedAdvertised }) => {
      const advertised = createAdvertisedCodexCapabilities(runtimeCapabilities);

      expect([...advertised].sort()).toEqual([...expectedAdvertised].sort());
      for (const capability of advertised) {
        const contract = getCodexCapabilityContract(capability);
        expect(contract?.exposure).toBe('advertised');
        expect(contract && 'enforcementGate' in contract && contract.enforcementGate.length > 0).toBe(true);
      }
    },
  );

  it('keeps advertised capabilities aligned with the named contract entries', () => {
    const expected = Object.entries(CODEX_CAPABILITY_CONTRACT)
      .filter(([, contract]) => contract.availability === 'base' && contract.exposure === 'advertised')
      .map(([capability]) => capability as RuntimeCapability);

    expect([...ADVERTISED_CODEX_CAPABILITIES].sort()).toEqual(expected.sort());
  });

  it('downgrades unsupported grounded surfaces to non-guaranteed runtime wording', () => {
    const advertised = createAdvertisedCodexCapabilities(new Set(CODEX_RUNTIME_CAPABILITIES));

    for (const capability of [
      'workspace_instructions',
      'tools_exec',
      'tools_fs',
      'tools_web',
      'mcp',
    ] as const) {
      const contract = getCodexCapabilityContract(capability);
      expect(contract?.exposure).toBe('transport_only');
      expect(contract?.runtimeWording).toMatch(/\bmay\b/i);
      expect(contract?.runtimeWording).toMatch(/not guaranteed/i);
      expect(advertised.has(capability)).toBe(false);
    }
  });
});

describe('requiredCapabilityForTool', () => {
  it('returns expected capability for known tools', () => {
    expect(requiredCapabilityForTool('Read')).toBe('tools_fs');
    expect(requiredCapabilityForTool('Bash')).toBe('tools_exec');
    expect(requiredCapabilityForTool('WebSearch')).toBe('tools_web');
  });

  it('returns undefined for unknown tools', () => {
    expect(requiredCapabilityForTool('CustomTool')).toBeUndefined();
  });
});

describe('filterToolsByCapabilities', () => {
  it('keeps only tool-compatible entries and reports dropped tools', () => {
    const result = filterToolsByCapabilities(
      ['Read', 'Bash', 'WebSearch', 'CustomTool'],
      new Set(['tools_fs']),
    );
    expect(result.tools).toEqual(['Read', 'CustomTool']);
    expect(result.dropped).toEqual(['Bash', 'WebSearch']);
  });

  it('keeps all tools when all required capabilities are present', () => {
    const result = filterToolsByCapabilities(
      ['Read', 'Bash', 'WebSearch'],
      new Set(['tools_fs', 'tools_exec', 'tools_web']),
    );
    expect(result.tools).toEqual(['Read', 'Bash', 'WebSearch']);
    expect(result.dropped).toEqual([]);
  });
});
