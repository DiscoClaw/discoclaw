import { describe, expect, it } from 'vitest';
import { filterToolsByCapabilities, requiredCapabilityForTool } from './tool-capabilities.js';

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
