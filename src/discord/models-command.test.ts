import { describe, it, expect, vi } from 'vitest';
import { parseModelsCommand, handleModelsCommand } from './models-command.js';
import type { ConfigContext } from './actions-config.js';
import * as actionsConfig from './actions-config.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('parseModelsCommand', () => {
  it('parses bare !models as show', () => {
    expect(parseModelsCommand('!models')).toEqual({ action: 'show' });
  });

  it('parses !models show', () => {
    expect(parseModelsCommand('!models show')).toEqual({ action: 'show' });
  });

  it('parses !models help', () => {
    expect(parseModelsCommand('!models help')).toEqual({ action: 'help' });
  });

  it('parses !models set with valid role and model', () => {
    expect(parseModelsCommand('!models set chat sonnet')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'sonnet',
    });
    expect(parseModelsCommand('!models set forge-drafter opus')).toEqual({
      action: 'set',
      role: 'forge-drafter',
      model: 'opus',
    });
  });

  it('returns error for !models set with invalid role', () => {
    const result = parseModelsCommand('!models set bogus sonnet');
    expect(result).toEqual({
      action: 'error',
      message: expect.stringContaining('Unknown role "bogus"'),
    });
    expect((result as any).message).toContain('chat');
  });

  it('maps "runtime" alias to "chat" role', () => {
    expect(parseModelsCommand('!models set runtime openai')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'openai',
    });
    expect(parseModelsCommand('!models set RUNTIME sonnet')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'sonnet',
    });
  });

  it('maps "runtime" alias in reset too', () => {
    expect(parseModelsCommand('!models reset runtime')).toEqual({
      action: 'reset',
      role: 'chat',
    });
  });

  it('rejects !models set with missing model', () => {
    expect(parseModelsCommand('!models set chat')).toBeNull();
  });

  it('returns null for non-models messages', () => {
    expect(parseModelsCommand('hello')).toBeNull();
    expect(parseModelsCommand('!health')).toBeNull();
    expect(parseModelsCommand('!restart')).toBeNull();
    expect(parseModelsCommand('!modelsxyz')).toBeNull();
  });

  it('is case-insensitive for command and role', () => {
    expect(parseModelsCommand('!MODELS')).toEqual({ action: 'show' });
    expect(parseModelsCommand('!Models Show')).toEqual({ action: 'show' });
    expect(parseModelsCommand('!MODELS SET CHAT sonnet')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'sonnet',
    });
  });

  it('preserves original case for model token', () => {
    expect(parseModelsCommand('!models set chat Claude-3-Opus')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'Claude-3-Opus',
    });
    expect(parseModelsCommand('!MODELS SET CHAT Sonnet')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'Sonnet',
    });
  });

  it('handles extra whitespace', () => {
    expect(parseModelsCommand('  !models  ')).toEqual({ action: 'show' });
    expect(parseModelsCommand('  !models   show  ')).toEqual({ action: 'show' });
    expect(parseModelsCommand('  !models  set  chat  sonnet  ')).toEqual({
      action: 'set',
      role: 'chat',
      model: 'sonnet',
    });
  });

  it('returns null for unknown subcommands', () => {
    expect(parseModelsCommand('!models bogus')).toBeNull();
    expect(parseModelsCommand('!models set')).toBeNull();
    expect(parseModelsCommand('!models show now')).toBeNull();
    expect(parseModelsCommand('!models set chat sonnet extra')).toBeNull();
  });

  it('parses all valid roles', () => {
    for (const role of ['chat', 'plan-run', 'fast', 'forge-drafter', 'forge-auditor', 'summary', 'cron', 'cron-exec', 'voice', 'imagegen']) {
      expect(parseModelsCommand(`!models set ${role} haiku`)).toEqual({
        action: 'set',
        role,
        model: 'haiku',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('handleModelsCommand', () => {
  const mockConfigCtx: ConfigContext = {
    botParams: {
      runtimeModel: 'sonnet',
      planRunModel: 'capable',
      summaryModel: 'haiku',
      forgeDrafterModel: 'opus',
      forgeAuditorModel: 'sonnet',
    },
    workspaceCwd: '/tmp/workspace',
    runtime: {
      id: 'claude-code',
      defaultModel: 'sonnet',
    } as any,
  };

  const enabled = { configCtx: mockConfigCtx, configEnabled: true };

  it('returns startup message when configCtx is undefined but feature is enabled', () => {
    const result = handleModelsCommand({ action: 'show' }, { configCtx: undefined, configEnabled: true });
    expect(result).toContain('not yet available');
    expect(result).toContain('starting up');
  });

  it('returns disabled message when configCtx is undefined and feature is disabled', () => {
    const result = handleModelsCommand({ action: 'show' }, { configCtx: undefined, configEnabled: false });
    expect(result).toContain('disabled');
    expect(result).not.toContain('starting up');
  });

  it('show delegates to executeConfigAction modelShow', () => {
    const spy = vi.spyOn(actionsConfig, 'executeConfigAction').mockReturnValue({
      ok: true,
      summary: '**chat**: `sonnet`\n**summary**: `haiku`',
    });
    const result = handleModelsCommand({ action: 'show' }, enabled);
    expect(spy).toHaveBeenCalledWith({ type: 'modelShow' }, mockConfigCtx);
    expect(result).toContain('sonnet');
    spy.mockRestore();
  });

  it('show appends the OpenRouter support-boundary note when OpenRouter is active', () => {
    const spy = vi.spyOn(actionsConfig, 'executeConfigAction').mockReturnValue({
      ok: true,
      summary: '**runtime**: `openrouter`\n**chat**: `openai/gpt-5-mini`',
    });
    const result = handleModelsCommand(
      { action: 'show' },
      {
        configCtx: {
          ...mockConfigCtx,
          runtime: {
            id: 'openrouter',
            defaultModel: 'openai/gpt-5-mini',
          } as any,
          runtimeName: 'openrouter',
        },
        configEnabled: true,
      },
    );
    expect(result).toContain('OPENROUTER_API_KEY');
    expect(result).toContain('config/routing state only');
    expect(result).toContain('openrouter-key: ok');
    spy.mockRestore();
  });

  it('set delegates to executeConfigAction modelSet', () => {
    const spy = vi.spyOn(actionsConfig, 'executeConfigAction').mockReturnValue({
      ok: true,
      summary: 'Model updated: chat → opus',
    });
    const result = handleModelsCommand(
      { action: 'set', role: 'chat', model: 'opus' },
      enabled,
    );
    expect(spy).toHaveBeenCalledWith(
      { type: 'modelSet', role: 'chat', model: 'opus' },
      mockConfigCtx,
    );
    expect(result).toContain('Model updated');
    spy.mockRestore();
  });

  it('set appends the OpenRouter verification note after switching chat to OpenRouter', () => {
    const openrouterCtx: ConfigContext = {
      ...mockConfigCtx,
      runtime: {
        id: 'openrouter',
        defaultModel: 'openai/gpt-5-mini',
      } as any,
      runtimeName: 'openrouter',
    };
    const spy = vi.spyOn(actionsConfig, 'executeConfigAction').mockImplementation(() => {
      openrouterCtx.runtimeName = 'openrouter';
      return {
        ok: true,
        summary: 'Model updated: runtime → openrouter, chat → openai/gpt-5-mini (adapter default)',
      };
    });
    const result = handleModelsCommand(
      { action: 'set', role: 'chat', model: 'openrouter' },
      { configCtx: openrouterCtx, configEnabled: true },
    );
    expect(result).toContain('runtime → openrouter');
    expect(result).toContain('OPENROUTER_API_KEY');
    expect(result).toContain('!status');
    spy.mockRestore();
  });

  it('set returns error string on failure', () => {
    const spy = vi.spyOn(actionsConfig, 'executeConfigAction').mockReturnValue({
      ok: false,
      error: 'Cron subsystem not configured',
    });
    const result = handleModelsCommand(
      { action: 'set', role: 'cron', model: 'haiku' },
      enabled,
    );
    expect(result).toContain('Error: Cron subsystem not configured');
    spy.mockRestore();
  });

  it('help returns usage text with roles and examples', () => {
    const result = handleModelsCommand({ action: 'help' }, enabled);
    expect(result).toContain('!models commands');
    expect(result).toContain('chat');
    expect(result).toContain('forge-drafter');
    expect(result).toContain('!models set chat sonnet');
  });

  it('help documents the OpenRouter env-key path and verification boundary', () => {
    const result = handleModelsCommand({ action: 'help' }, enabled);
    expect(result).toContain('OPENROUTER_API_KEY');
    expect(result).toContain('config/routing only');
    expect(result).toContain('openrouter-key: ok');
  });

  it('help mentions imagegen configuration', () => {
    const result = handleModelsCommand({ action: 'help' }, enabled);
    expect(result).toContain('imagegen');
    expect(result).toContain('!models set imagegen');
    expect(result).toContain('!models reset imagegen');
  });
});
