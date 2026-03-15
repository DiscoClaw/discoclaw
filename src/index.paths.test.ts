import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCronTagBootstrapForumId, resolveSessionStorePath } from './index.paths.js';

describe('resolveSessionStorePath', () => {
  it('uses configured data dir when provided', () => {
    const out = resolveSessionStorePath('/var/lib/discoclaw', '/repo');
    expect(out).toBe(path.join('/var/lib/discoclaw', 'sessions.json'));
  });

  it('falls back to <projectRoot>/data when data dir is empty', () => {
    const out = resolveSessionStorePath('', '/repo');
    expect(out).toBe(path.join('/repo', 'data', 'sessions.json'));
  });
});

describe('resolveCronTagBootstrapForumId', () => {
  it('prefers initCronForum resolved forum id', () => {
    const out = resolveCronTagBootstrapForumId({
      resolvedForumId: '123456789012345678',
      configuredForumRef: 'automations',
    });
    expect(out).toBe('123456789012345678');
  });

  it('accepts configured forum ref only when it is a snowflake id', () => {
    const out = resolveCronTagBootstrapForumId({
      resolvedForumId: '',
      configuredForumRef: '123456789012345678',
    });
    expect(out).toBe('123456789012345678');
  });

  it('returns null when forum ref is a non-id name and no resolved id exists', () => {
    const out = resolveCronTagBootstrapForumId({
      resolvedForumId: '',
      configuredForumRef: 'automations',
    });
    expect(out).toBeNull();
  });
});
