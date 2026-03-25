import { describe, expect, it } from 'vitest';
import {
  canonicalizeRuntimePathName,
  getRuntimePlacementDefinition,
  getRuntimePathDefinition,
  getRuntimeProviderSecretEnvKey,
  isRuntimeNameSupportedInPlacement,
  listCanonicalRuntimeNames,
  parseRuntimeNameForPlacement,
  type RuntimePathPlacement,
} from './runtime-path-contract.js';

describe('runtime-path-contract', () => {
  it('canonicalizes documented compatibility aliases', () => {
    expect(canonicalizeRuntimePathName(' claude ')).toBe('claude-cli');
    expect(canonicalizeRuntimePathName('CLAUDE_CODE')).toBe('claude-cli');
    expect(canonicalizeRuntimePathName('claude-cli')).toBe('claude-cli');
    expect(canonicalizeRuntimePathName('anthropic')).toBe('claude-api');
    expect(canonicalizeRuntimePathName('claude-api')).toBe('claude-api');
    expect(canonicalizeRuntimePathName('codex')).toBe('codex-cli');
    expect(canonicalizeRuntimePathName('codex-cli')).toBe('codex-cli');
    expect(canonicalizeRuntimePathName('gemini-api')).toBe('gemini-api');
    expect(canonicalizeRuntimePathName('')).toBeUndefined();
    expect(canonicalizeRuntimePathName('not-a-runtime')).toBeUndefined();
  });

  it('rejects removed runtime names', () => {
    expect(canonicalizeRuntimePathName('gemini')).toBeUndefined();
    expect(canonicalizeRuntimePathName('gemini-cli')).toBeUndefined();
  });

  it('keeps runtime metadata explicit about registry keys, runtime ids, and env-key-backed providers', () => {
    expect(getRuntimePathDefinition('claude')).toEqual({
      canonicalName: 'claude-cli',
      acceptedAliases: ['claude-cli', 'claude', 'claude_code'],
      registryKeys: ['claude-cli'],
      runtimeId: 'claude_code',
    });

    expect(getRuntimePathDefinition('gemini-api')).toEqual({
      canonicalName: 'gemini-api',
      acceptedAliases: ['gemini-api'],
      registryKeys: ['gemini-api'],
      runtimeId: 'gemini',
      providerSecretEnvKey: 'GEMINI_API_KEY',
    });

    expect(getRuntimePathDefinition('anthropic')).toEqual({
      canonicalName: 'claude-api',
      acceptedAliases: ['claude-api', 'anthropic'],
      registryKeys: ['claude-api'],
      runtimeId: 'claude_code',
      providerSecretEnvKey: 'ANTHROPIC_API_KEY',
    });

    expect(getRuntimePathDefinition('codex')).toEqual({
      canonicalName: 'codex-cli',
      acceptedAliases: ['codex-cli', 'codex'],
      registryKeys: ['codex-cli'],
      runtimeId: 'codex',
    });
  });

  it('returns provider secret lookups only for env-key-backed runtime paths', () => {
    expect(getRuntimeProviderSecretEnvKey('openai')).toBe('OPENAI_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('gemini-api')).toBe('GEMINI_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('claude-api')).toBe('ANTHROPIC_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY');

    expect(getRuntimeProviderSecretEnvKey('claude-cli')).toBeUndefined();
    expect(getRuntimeProviderSecretEnvKey('codex-cli')).toBeUndefined();
  });

  it('keeps startup and fast placements on the canonical five operator-facing runtime paths', () => {
    const startupPlacements: RuntimePathPlacement[] = [
      'startup:PRIMARY_RUNTIME',
      'startup:DISCOCLAW_FAST_RUNTIME',
      'startup:FORGE_DRAFTER_RUNTIME',
      'startup:FORGE_AUDITOR_RUNTIME',
      'live:chat',
      'runtime-overrides:fastRuntime',
    ];

    for (const placement of startupPlacements) {
      expect(listCanonicalRuntimeNames(placement)).toEqual([
        'claude-cli',
        'codex-cli',
        'gemini-api',
        'openai',
        'openrouter',
      ]);
      expect(isRuntimeNameSupportedInPlacement('claude_code', placement)).toBe(true);
      expect(isRuntimeNameSupportedInPlacement('claude-api', placement)).toBe(false);
      expect(parseRuntimeNameForPlacement('claude-api', placement)).toBeUndefined();
    }
  });

  it('allows claude-api only on the voice-specific runtime paths', () => {
    const voicePlacements: RuntimePathPlacement[] = [
      'live:voice',
      'runtime-overrides:voiceRuntime',
    ];

    for (const placement of voicePlacements) {
      expect(listCanonicalRuntimeNames(placement)).toEqual([
        'claude-cli',
        'codex-cli',
        'gemini-api',
        'openai',
        'openrouter',
        'claude-api',
      ]);
      expect(isRuntimeNameSupportedInPlacement('claude-api', placement)).toBe(true);
      expect(parseRuntimeNameForPlacement('anthropic', placement)).toBe('claude-api');
    }
  });

  it('captures persistence and reset semantics by placement', () => {
    expect(getRuntimePlacementDefinition('startup:PRIMARY_RUNTIME')).toEqual({
      placement: 'startup:PRIMARY_RUNTIME',
      persistence: 'env',
      resetBehavior: 'edit-env-and-restart',
      supportedRuntimeNames: ['claude-cli', 'codex-cli', 'gemini-api', 'openai', 'openrouter'],
    });

    expect(getRuntimePlacementDefinition('live:chat')).toEqual({
      placement: 'live:chat',
      persistence: 'memory',
      resetBehavior: 'restart-or-explicit-runtime-switch',
      supportedRuntimeNames: ['claude-cli', 'codex-cli', 'gemini-api', 'openai', 'openrouter'],
    });

    expect(getRuntimePlacementDefinition('runtime-overrides:fastRuntime')).toEqual({
      placement: 'runtime-overrides:fastRuntime',
      persistence: 'runtime-overrides.json',
      resetBehavior: '!models reset fast',
      supportedRuntimeNames: ['claude-cli', 'codex-cli', 'gemini-api', 'openai', 'openrouter'],
    });

    expect(getRuntimePlacementDefinition('runtime-overrides:voiceRuntime')).toEqual({
      placement: 'runtime-overrides:voiceRuntime',
      persistence: 'runtime-overrides.json',
      resetBehavior: '!models reset voice',
      supportedRuntimeNames: ['claude-cli', 'codex-cli', 'gemini-api', 'openai', 'openrouter', 'claude-api'],
    });
  });

  it('lists all canonical runtime paths in one place', () => {
    expect(listCanonicalRuntimeNames()).toEqual([
      'claude-api',
      'claude-cli',
      'codex-cli',
      'gemini-api',
      'openai',
      'openrouter',
    ]);
  });
});
