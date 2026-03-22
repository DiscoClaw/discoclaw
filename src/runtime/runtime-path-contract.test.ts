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
    expect(canonicalizeRuntimePathName(' claude ')).toBe('claude');
    expect(canonicalizeRuntimePathName('CLAUDE_CODE')).toBe('claude');
    expect(canonicalizeRuntimePathName('Gemini')).toBe('gemini-api');
    expect(canonicalizeRuntimePathName('gemini-api')).toBe('gemini-api');
    expect(canonicalizeRuntimePathName('gemini-cli')).toBe('gemini-cli');
    expect(canonicalizeRuntimePathName('')).toBeUndefined();
    expect(canonicalizeRuntimePathName('not-a-runtime')).toBeUndefined();
  });

  it('keeps runtime metadata explicit about registry keys, runtime ids, and env-key-backed providers', () => {
    expect(getRuntimePathDefinition('claude')).toEqual({
      canonicalName: 'claude',
      acceptedAliases: ['claude', 'claude_code'],
      registryKeys: ['claude', 'claude_code'],
      runtimeId: 'claude_code',
    });

    expect(getRuntimePathDefinition('gemini')).toEqual({
      canonicalName: 'gemini-api',
      acceptedAliases: ['gemini-api', 'gemini'],
      registryKeys: ['gemini-api', 'gemini'],
      runtimeId: 'gemini',
      providerSecretEnvKey: 'GEMINI_API_KEY',
    });

    expect(getRuntimePathDefinition('anthropic')).toEqual({
      canonicalName: 'anthropic',
      acceptedAliases: ['anthropic'],
      registryKeys: ['anthropic'],
      runtimeId: 'claude_code',
      providerSecretEnvKey: 'ANTHROPIC_API_KEY',
    });
  });

  it('returns provider secret lookups only for env-key-backed runtime paths', () => {
    expect(getRuntimeProviderSecretEnvKey('openai')).toBe('OPENAI_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('openrouter')).toBe('OPENROUTER_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('gemini')).toBe('GEMINI_API_KEY');
    expect(getRuntimeProviderSecretEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY');

    expect(getRuntimeProviderSecretEnvKey('claude')).toBeUndefined();
    expect(getRuntimeProviderSecretEnvKey('codex')).toBeUndefined();
    expect(getRuntimeProviderSecretEnvKey('gemini-cli')).toBeUndefined();
  });

  it('keeps startup and fast placements on the canonical six operator-facing runtime paths', () => {
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
        'claude',
        'codex',
        'gemini-api',
        'gemini-cli',
        'openai',
        'openrouter',
      ]);
      expect(isRuntimeNameSupportedInPlacement('claude_code', placement)).toBe(true);
      expect(isRuntimeNameSupportedInPlacement('gemini', placement)).toBe(true);
      expect(isRuntimeNameSupportedInPlacement('anthropic', placement)).toBe(false);
      expect(parseRuntimeNameForPlacement('anthropic', placement)).toBeUndefined();
    }
  });

  it('allows anthropic only on the voice-specific runtime paths', () => {
    const voicePlacements: RuntimePathPlacement[] = [
      'live:voice',
      'runtime-overrides:voiceRuntime',
    ];

    for (const placement of voicePlacements) {
      expect(listCanonicalRuntimeNames(placement)).toEqual([
        'claude',
        'codex',
        'gemini-api',
        'gemini-cli',
        'openai',
        'openrouter',
        'anthropic',
      ]);
      expect(isRuntimeNameSupportedInPlacement('anthropic', placement)).toBe(true);
      expect(parseRuntimeNameForPlacement('anthropic', placement)).toBe('anthropic');
      expect(parseRuntimeNameForPlacement('gemini', placement)).toBe('gemini-api');
    }
  });

  it('captures persistence and reset semantics by placement', () => {
    expect(getRuntimePlacementDefinition('startup:PRIMARY_RUNTIME')).toEqual({
      placement: 'startup:PRIMARY_RUNTIME',
      persistence: 'env',
      resetBehavior: 'edit-env-and-restart',
      supportedRuntimeNames: ['claude', 'codex', 'gemini-api', 'gemini-cli', 'openai', 'openrouter'],
    });

    expect(getRuntimePlacementDefinition('live:chat')).toEqual({
      placement: 'live:chat',
      persistence: 'memory',
      resetBehavior: 'restart-or-explicit-runtime-switch',
      supportedRuntimeNames: ['claude', 'codex', 'gemini-api', 'gemini-cli', 'openai', 'openrouter'],
    });

    expect(getRuntimePlacementDefinition('runtime-overrides:fastRuntime')).toEqual({
      placement: 'runtime-overrides:fastRuntime',
      persistence: 'runtime-overrides.json',
      resetBehavior: '!models reset fast',
      supportedRuntimeNames: ['claude', 'codex', 'gemini-api', 'gemini-cli', 'openai', 'openrouter'],
    });

    expect(getRuntimePlacementDefinition('runtime-overrides:voiceRuntime')).toEqual({
      placement: 'runtime-overrides:voiceRuntime',
      persistence: 'runtime-overrides.json',
      resetBehavior: '!models reset voice',
      supportedRuntimeNames: ['claude', 'codex', 'gemini-api', 'gemini-cli', 'openai', 'openrouter', 'anthropic'],
    });
  });

  it('lists all canonical runtime paths in one place', () => {
    expect(listCanonicalRuntimeNames()).toEqual([
      'anthropic',
      'claude',
      'codex',
      'gemini-api',
      'gemini-cli',
      'openai',
      'openrouter',
    ]);
  });
});
