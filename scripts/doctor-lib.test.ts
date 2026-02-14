import { describe, expect, it } from 'vitest';
import { checkRequiredForums } from './doctor-lib.js';

describe('doctor-lib: required forums', () => {
  it('fails when enabled-by-default forums are missing', () => {
    const checks = checkRequiredForums({});
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_CRON_FORUM is required'))).toBe(true);
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_BEADS_FORUM is required'))).toBe(true);
  });

  it('passes when both required forums are valid snowflakes', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_FORUM: '1000000000000000001',
      DISCOCLAW_BEADS_FORUM: '1000000000000000002',
    });
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_CRON_FORUM is set and valid'))).toBe(true);
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_BEADS_FORUM is set and valid'))).toBe(true);
  });

  it('does not require cron forum when cron is disabled', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_ENABLED: '0',
      DISCOCLAW_BEADS_FORUM: '1000000000000000002',
    });
    expect(checks.some((c) => c.label.includes('DISCOCLAW_CRON_FORUM'))).toBe(false);
  });

  it('fails invalid boolean toggles with actionable error', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_ENABLED: 'yes',
      DISCOCLAW_BEADS_ENABLED: 'nope',
    });
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_CRON_ENABLED must'))).toBe(true);
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_BEADS_ENABLED must'))).toBe(true);
  });
});
