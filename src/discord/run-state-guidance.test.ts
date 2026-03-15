import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./forge-plan-registry.js', () => ({
  isRunActiveInChannel: vi.fn(),
}));

import { isRunActiveInChannel } from './forge-plan-registry.js';
import { buildRunStateGuidance } from './run-state-guidance.js';

describe('buildRunStateGuidance', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('warns against claiming new work is starting when no run is active', () => {
    vi.mocked(isRunActiveInChannel).mockReturnValue(false);

    const guidance = buildRunStateGuidance('channel-1');

    expect(guidance).toContain('there is no active forge or plan run in this channel right now');
    expect(guidance).toContain('do not say you are proceeding now');
    expect(guidance).toContain('Say clearly that you have not started yet');
  });

  it('uses the active-run guidance when a tracked run is live', () => {
    vi.mocked(isRunActiveInChannel).mockReturnValue(true);

    const guidance = buildRunStateGuidance('channel-1');

    expect(guidance).toContain('a forge or plan run is currently active in this channel');
    expect(guidance).not.toContain('Say clearly that you have not started yet');
  });
});
