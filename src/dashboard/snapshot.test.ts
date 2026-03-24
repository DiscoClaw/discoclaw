import { describe, expect, it, vi } from 'vitest';
import type { ImagegenContext } from '../discord/actions-imagegen.js';
import {
  buildImagegenOptions,
  collectLiveSnapshot,
  fetchGeminiImagegenModels,
} from './snapshot.js';

// ---------------------------------------------------------------------------
// fetchGeminiImagegenModels
// ---------------------------------------------------------------------------

describe('fetchGeminiImagegenModels', () => {
  it('returns image-capable model IDs from the API response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-3.1-flash' },
          { name: 'models/gemini-3.1-flash-image-preview' },
          { name: 'models/imagen-4.0-generate-001' },
          { name: 'models/text-bison-001' },
        ],
      }),
    });

    const result = await fetchGeminiImagegenModels('test-key', mockFetch as unknown as typeof fetch);

    expect(result).toEqual([
      'gemini-3.1-flash-image-preview',
      'imagen-4.0-generate-001',
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models?key=test-key',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns empty array on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await fetchGeminiImagegenModels('bad-key', mockFetch as unknown as typeof fetch);
    expect(result).toEqual([]);
  });

  it('returns empty array on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
    const result = await fetchGeminiImagegenModels('test-key', mockFetch as unknown as typeof fetch);
    expect(result).toEqual([]);
  });

  it('returns empty array when models field is missing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const result = await fetchGeminiImagegenModels('test-key', mockFetch as unknown as typeof fetch);
    expect(result).toEqual([]);
  });

  it('skips entries with missing or non-string name', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 123 },
          {},
          { name: 'models/imagen-4.0-fast-generate-001' },
        ],
      }),
    });
    const result = await fetchGeminiImagegenModels('test-key', mockFetch as unknown as typeof fetch);
    expect(result).toEqual(['imagen-4.0-fast-generate-001']);
  });
});

// ---------------------------------------------------------------------------
// buildImagegenOptions
// ---------------------------------------------------------------------------

describe('buildImagegenOptions', () => {
  it('uses hardcoded fallback when geminiImageModels is not set', () => {
    const ctx: ImagegenContext = { geminiApiKey: 'key' };
    const options = buildImagegenOptions(ctx);
    expect(options).toContain('gemini-3.1-flash-image-preview');
    expect(options).toContain('imagen-4.0-generate-001');
  });

  it('uses dynamically fetched models when geminiImageModels is populated', () => {
    const ctx: ImagegenContext = {
      geminiApiKey: 'key',
      geminiImageModels: ['custom-image-model', 'imagen-5.0-generate-001'],
    };
    const options = buildImagegenOptions(ctx);
    expect(options).toEqual(['custom-image-model', 'imagen-5.0-generate-001']);
    // Should NOT contain hardcoded fallback models
    expect(options).not.toContain('gemini-3.1-flash-image-preview');
  });

  it('falls back to hardcoded list when geminiImageModels is empty', () => {
    const ctx: ImagegenContext = {
      geminiApiKey: 'key',
      geminiImageModels: [],
    };
    const options = buildImagegenOptions(ctx);
    expect(options).toContain('gemini-3.1-flash-image-preview');
  });

  it('includes OpenAI models when apiKey is present', () => {
    const ctx: ImagegenContext = { apiKey: 'oai-key' };
    const options = buildImagegenOptions(ctx);
    expect(options).toContain('dall-e-3');
    expect(options).toContain('gpt-image-1');
  });

  it('prepends defaultModel when not already in the list', () => {
    const ctx: ImagegenContext = {
      geminiApiKey: 'key',
      defaultModel: 'my-custom-model',
    };
    const options = buildImagegenOptions(ctx);
    expect(options[0]).toBe('my-custom-model');
  });

  it('does not duplicate defaultModel if already present', () => {
    const ctx: ImagegenContext = {
      geminiApiKey: 'key',
      defaultModel: 'gemini-3.1-flash-image-preview',
    };
    const options = buildImagegenOptions(ctx);
    const count = options.filter((m) => m === 'gemini-3.1-flash-image-preview').length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// collectLiveSnapshot
// ---------------------------------------------------------------------------

describe('collectLiveSnapshot', () => {
  it('populates imagegen fields when imagegenCtx is provided', () => {
    const snap = collectLiveSnapshot({
      runtimeName: 'claude',
      runtimeModel: 'opus',
      availableRuntimes: ['claude', 'openrouter'],
      pendingRestart: false,
      imagegenCtx: { geminiApiKey: 'key' },
    });

    expect(snap.imagegenProvider).toBe('gemini');
    expect(snap.imagegenModel).toBe('gemini-3.1-flash-image-preview');
    expect(snap.imagegenOptions.length).toBeGreaterThan(0);
    expect(snap.imagegenHasGeminiKey).toBe(true);
    expect(snap.imagegenHasOpenaiKey).toBe(false);
  });

  it('returns undefined imagegen fields when imagegenCtx is missing', () => {
    const snap = collectLiveSnapshot({
      runtimeName: 'claude',
      runtimeModel: 'opus',
      availableRuntimes: ['claude'],
      pendingRestart: false,
    });

    expect(snap.imagegenProvider).toBeUndefined();
    expect(snap.imagegenModel).toBeUndefined();
    expect(snap.imagegenOptions).toEqual([]);
    expect(snap.imagegenHasGeminiKey).toBe(false);
    expect(snap.imagegenHasOpenaiKey).toBe(false);
  });

  it('uses fetched gemini models in imagegen options', () => {
    const snap = collectLiveSnapshot({
      runtimeName: 'claude',
      runtimeModel: 'opus',
      availableRuntimes: ['claude'],
      pendingRestart: false,
      imagegenCtx: {
        geminiApiKey: 'key',
        geminiImageModels: ['fetched-image-model'],
      },
    });

    expect(snap.imagegenOptions).toEqual(['fetched-image-model']);
  });

  it('passes through chatThinking and pendingRestart', () => {
    const snap = collectLiveSnapshot({
      runtimeName: 'claude',
      runtimeModel: 'opus',
      chatThinking: 'enabled',
      availableRuntimes: ['claude'],
      pendingRestart: true,
    });

    expect(snap.chatThinking).toBe('enabled');
    expect(snap.pendingRestart).toBe(true);
  });

  it('reports both key presence flags when both keys are set', () => {
    const snap = collectLiveSnapshot({
      runtimeName: 'claude',
      runtimeModel: 'opus',
      availableRuntimes: ['claude'],
      pendingRestart: false,
      imagegenCtx: { apiKey: 'oai-key', geminiApiKey: 'gem-key' },
    });

    expect(snap.imagegenHasOpenaiKey).toBe(true);
    expect(snap.imagegenHasGeminiKey).toBe(true);
  });
});
