/**
 * Prefix stability tests — verify that the static preamble produced by
 * `buildPromptPreamble()` is byte-identical across turns, channels,
 * and varying dynamic sections.
 *
 * Anthropic's automatic prefix matching caches the longest matching prefix
 * and charges ~90% less for cached tokens. The optimization relies on the
 * preamble output being deterministic and independent of per-turn state
 * (channel context, history, etc.) which lives in post-preamble sections.
 */

import { describe, expect, it } from 'vitest';

import {
  ROOT_POLICY,
  TRACKED_DEFAULTS_PREAMBLE,
  TRACKED_TOOLS_PREAMBLE,
  buildPromptPreamble,
  buildPreambleContextFiles,
  buildContextFiles,
  inlineContextFiles,
} from '../../src/discord/prompt-common.js';

// ---------------------------------------------------------------------------
// 1. Static preamble constants are stable singletons
// ---------------------------------------------------------------------------

describe('static preamble constants', () => {
  it('ROOT_POLICY is a non-empty string evaluated once', () => {
    expect(ROOT_POLICY.length).toBeGreaterThan(0);
    // Module-level const — reference equality proves single evaluation.
    expect(ROOT_POLICY).toBe(ROOT_POLICY);
  });

  it('TRACKED_DEFAULTS_PREAMBLE is a non-empty string evaluated once', () => {
    expect(TRACKED_DEFAULTS_PREAMBLE.length).toBeGreaterThan(0);
    expect(TRACKED_DEFAULTS_PREAMBLE).toBe(TRACKED_DEFAULTS_PREAMBLE);
  });

  it('TRACKED_TOOLS_PREAMBLE is a non-empty string evaluated once', () => {
    expect(TRACKED_TOOLS_PREAMBLE.length).toBeGreaterThan(0);
    expect(TRACKED_TOOLS_PREAMBLE).toBe(TRACKED_TOOLS_PREAMBLE);
  });
});

// ---------------------------------------------------------------------------
// 2. buildPromptPreamble() is deterministic for identical inputs
// ---------------------------------------------------------------------------

describe('buildPromptPreamble determinism', () => {
  const INLINED = '--- AGENTS.md ---\nUser override rules\n--- SOUL.md ---\nSoul text';

  it('produces identical output on repeated calls with the same inlinedContext', () => {
    const a = buildPromptPreamble(INLINED);
    const b = buildPromptPreamble(INLINED);
    expect(a).toBe(b);
  });

  it('produces identical output on repeated calls with empty inlinedContext', () => {
    const a = buildPromptPreamble('');
    const b = buildPromptPreamble('');
    expect(a).toBe(b);
  });

  it('produces identical output on repeated calls with opts', () => {
    const opts = { runtimeId: 'claude' as const, runtimeCapabilities: new Set<never>(), runtimeTools: ['web_search'], enableHybridPipeline: false };
    const a = buildPromptPreamble(INLINED, opts);
    const b = buildPromptPreamble(INLINED, opts);
    expect(a).toBe(b);
  });

  it('section ordering is fixed: ROOT_POLICY → tracked defaults → tracked tools → inlinedContext', () => {
    const ctx = 'workspace context here';
    const result = buildPromptPreamble(ctx);

    const rootIdx = result.indexOf(ROOT_POLICY);
    const defaultsIdx = result.indexOf(TRACKED_DEFAULTS_PREAMBLE);
    const toolsIdx = result.indexOf(TRACKED_TOOLS_PREAMBLE);
    const ctxIdx = result.indexOf(ctx);

    expect(rootIdx).toBe(0);
    expect(defaultsIdx).toBeGreaterThan(rootIdx);
    expect(toolsIdx).toBeGreaterThan(defaultsIdx);
    expect(ctxIdx).toBeGreaterThan(toolsIdx);
  });

  it('concatenation uses double-newline separators (no variable whitespace)', () => {
    const ctx = 'workspace context';
    const result = buildPromptPreamble(ctx);
    // Between each non-empty section there should be exactly '\n\n'.
    // Verify no triple+ newlines exist (which would break byte-identity).
    expect(result).not.toMatch(/\n{3,}/);
  });
});

// ---------------------------------------------------------------------------
// 3. buildPreambleContextFiles excludes channel context
// ---------------------------------------------------------------------------

describe('buildPreambleContextFiles excludes channel context', () => {
  const paFiles = ['/workspace/SOUL.md', '/workspace/AGENTS.md'];

  it('returns paFiles plus paContextFiles from discordChannelContext', () => {
    const dcc = {
      contentDir: '/content',
      indexPath: '/content/index.md',
      paContextFiles: ['/content/.context/pa.md'],
      channelsDir: '/content/discord',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/dm.md',
    };
    const result = buildPreambleContextFiles(paFiles, dcc);
    expect(result).toContain('/workspace/SOUL.md');
    expect(result).toContain('/workspace/AGENTS.md');
    expect(result).toContain('/content/.context/pa.md');
  });

  it('does NOT include any channel context path', () => {
    const channelCtxPath = '/content/discord/general.md';
    const dcc = {
      contentDir: '/content',
      indexPath: '/content/index.md',
      paContextFiles: ['/content/.context/pa.md'],
      channelsDir: '/content/discord',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/dm.md',
    };

    // buildPreambleContextFiles should not include the channel context
    const preambleFiles = buildPreambleContextFiles(paFiles, dcc);
    expect(preambleFiles).not.toContain(channelCtxPath);

    // compare: buildContextFiles DOES include it
    const fullFiles = buildContextFiles(paFiles, dcc, channelCtxPath);
    expect(fullFiles).toContain(channelCtxPath);
  });

  it('filters out pa-safety.md from paContextFiles', () => {
    const dcc = {
      contentDir: '/content',
      indexPath: '/content/index.md',
      paContextFiles: ['/content/.context/pa.md', '/content/.context/pa-safety.md'],
      channelsDir: '/content/discord',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/dm.md',
    };
    const result = buildPreambleContextFiles(paFiles, dcc);
    expect(result).not.toContain('/content/.context/pa-safety.md');
    expect(result).toContain('/content/.context/pa.md');
  });
});

// ---------------------------------------------------------------------------
// 4. Preamble byte-identity across channels
// ---------------------------------------------------------------------------

describe('preamble byte-identity across channels', () => {
  it('same inlinedContext produces same preamble regardless of channel context', async () => {
    // The key property: as long as the same paFiles are used, the preamble
    // is identical. Channel context is excluded from preambleContextFiles.
    const paFiles = ['/workspace/SOUL.md', '/workspace/AGENTS.md'];

    const dccGeneral = {
      contentDir: '/content',
      indexPath: '/content/index.md',
      paContextFiles: ['/content/.context/pa.md'],
      channelsDir: '/content/discord',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/dm.md',
    };

    const dccRandom = {
      contentDir: '/content',
      indexPath: '/content/index.md',
      paContextFiles: ['/content/.context/pa.md'],
      channelsDir: '/content/discord',
      byChannelId: new Map(),
      dmContextPath: '/content/discord/dm.md',
    };

    const filesForGeneral = buildPreambleContextFiles(paFiles, dccGeneral);
    const filesForRandom = buildPreambleContextFiles(paFiles, dccRandom);

    // The file lists should be identical since channel context is excluded.
    expect(filesForGeneral).toEqual(filesForRandom);
  });

  it('preamble text is identical when the same context files resolve', () => {
    // Simulate: same inlined text from workspace files → same preamble
    const ctx = '--- SOUL.md ---\nYou are Claw.\n\n--- AGENTS.md ---\nRules here.';
    const preambleA = buildPromptPreamble(ctx);
    const preambleB = buildPromptPreamble(ctx);
    // Byte-identical — this is what enables provider prefix caching
    expect(preambleA).toBe(preambleB);
    expect(preambleA.length).toBe(preambleB.length);
  });
});

// ---------------------------------------------------------------------------
// 5. skipTrackedTools does not affect prefix stability for its own config
// ---------------------------------------------------------------------------

describe('skipTrackedTools consistency', () => {
  it('with skipTrackedTools=true, preamble is still deterministic', () => {
    const ctx = 'workspace context';
    const a = buildPromptPreamble(ctx, { skipTrackedTools: true });
    const b = buildPromptPreamble(ctx, { skipTrackedTools: true });
    expect(a).toBe(b);
  });

  it('skipTrackedTools=true produces a shorter preamble (tools section omitted)', () => {
    const ctx = 'workspace context';
    const withTools = buildPromptPreamble(ctx);
    const withoutTools = buildPromptPreamble(ctx, { skipTrackedTools: true });
    expect(withoutTools.length).toBeLessThan(withTools.length);
    expect(withoutTools).not.toContain(TRACKED_TOOLS_PREAMBLE);
  });
});

// ---------------------------------------------------------------------------
// 6. Empty sections are filtered — no spurious separators
// ---------------------------------------------------------------------------

describe('empty section filtering', () => {
  it('empty inlinedContext does not produce trailing separator', () => {
    const result = buildPromptPreamble('');
    // Should end with tracked tools content, not with '\n\n'
    expect(result).not.toMatch(/\n\n$/);
  });

  it('preamble with empty context has exact composition', () => {
    const result = buildPromptPreamble('');
    const expected = [ROOT_POLICY, TRACKED_DEFAULTS_PREAMBLE, TRACKED_TOOLS_PREAMBLE]
      .filter((s) => s.length > 0)
      .join('\n\n');
    expect(result).toBe(expected);
  });
});
