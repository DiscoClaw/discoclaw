import { describe, expect, it } from 'vitest';
import {
  ADVERTISED_CODEX_CAPABILITIES,
  CODEX_RUNTIME_CAPABILITIES,
  createAdvertisedCodexCapabilities,
  filterToolsByCapabilities,
  requiredCapabilityForTool,
} from './tool-capabilities.js';

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

  it('preserves mid-turn steering only when the raw runtime state includes it', () => {
    const advertised = createAdvertisedCodexCapabilities(
      new Set([...CODEX_RUNTIME_CAPABILITIES, 'mid_turn_steering']),
    );

    expect([...advertised].sort()).toEqual(
      [...ADVERTISED_CODEX_CAPABILITIES, 'mid_turn_steering'].sort(),
    );
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
