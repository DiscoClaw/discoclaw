import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OnboardingValues } from '../onboarding/onboarding-flow.js';
import type { WriteResult } from '../onboarding/onboarding-writer.js';
import type { SendTarget, CronDispatchConfig } from './onboarding-completion.js';
import { completeOnboarding } from './onboarding-completion.js';
import type { DiscordActionResult } from './actions.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../onboarding/onboarding-writer.js', () => ({
  writeWorkspaceFiles: vi.fn(),
}));

vi.mock('./actions-crons.js', () => ({
  executeCronAction: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseValues: OnboardingValues = {
  userName: 'David',
  timezone: 'America/New_York',
  morningCheckin: false,
};

const checkinValues: OnboardingValues = {
  ...baseValues,
  morningCheckin: true,
};

function makeWriteResult(overrides?: Partial<WriteResult>): WriteResult {
  return {
    written: ['IDENTITY.md', 'USER.md'],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function makeSendTarget(): { send: ReturnType<typeof vi.fn>; asSendTarget: SendTarget } {
  const send = vi.fn(async () => {});
  return { send, asSendTarget: { send } };
}

function makeActionCtx() {
  return {
    guild: { id: 'guild-1' } as any,
    client: {} as any,
    channelId: 'ch-1',
    messageId: 'msg-1',
  };
}

function makeCronDispatch(): CronDispatchConfig & { log: ReturnType<typeof vi.fn> } {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
  return {
    cronCtx: {} as any,
    actionCtx: makeActionCtx(),
    log,
  };
}

async function getWriteWorkspaceFiles() {
  const mod = await import('../onboarding/onboarding-writer.js');
  return vi.mocked(mod.writeWorkspaceFiles);
}

async function getExecuteCronAction() {
  const mod = await import('./actions-crons.js');
  return vi.mocked(mod.executeCronAction);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('completeOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes workspace files', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());

    const { asSendTarget } = makeSendTarget();
    await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(writeWorkspaceFiles).toHaveBeenCalledWith(baseValues, '/workspace');
  });

  it('sends success message on write success', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());

    const { send, asSendTarget } = makeSendTarget();
    await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].content).toContain('All set');
    expect(send.mock.calls[0][0].content).toContain('IDENTITY.md');
  });

  it('includes warnings in success message', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(
      makeWriteResult({ warnings: ['USER.md has unresolved placeholders: {{name}}'] }),
    );

    const { send, asSendTarget } = makeSendTarget();
    await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(send.mock.calls[0][0].content).toContain('unresolved placeholders');
  });

  it('returns writeResult in result object', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    const wr = makeWriteResult();
    writeWorkspaceFiles.mockResolvedValue(wr);

    const { asSendTarget } = makeSendTarget();
    const result = await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(result.writeResult).toBe(wr);
  });

  it('sends error message and returns early on write errors', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(
      makeWriteResult({ written: [], errors: ['Failed to write IDENTITY.md: EACCES'] }),
    );

    const { send, asSendTarget } = makeSendTarget();
    const result = await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].content).toContain('went wrong');
    expect(send.mock.calls[0][0].content).toContain('EACCES');
    expect(result.cronResult).toBeUndefined();
  });

  it('does not dispatch cron when morningCheckin is false', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());
    const executeCronAction = await getExecuteCronAction();

    const { asSendTarget } = makeSendTarget();
    const cronDispatch = makeCronDispatch();
    await completeOnboarding(baseValues, '/workspace', asSendTarget, cronDispatch);

    expect(executeCronAction).not.toHaveBeenCalled();
  });

  it('does not dispatch cron when cronDispatch is not provided', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());
    const executeCronAction = await getExecuteCronAction();

    const { asSendTarget } = makeSendTarget();
    await completeOnboarding(checkinValues, '/workspace', asSendTarget);

    expect(executeCronAction).not.toHaveBeenCalled();
  });

  it('dispatches morning cron when morningCheckin is true and cronDispatch is provided', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());
    const executeCronAction = await getExecuteCronAction();
    executeCronAction.mockResolvedValue({ ok: true, summary: 'Cron created' } satisfies DiscordActionResult);

    const { asSendTarget } = makeSendTarget();
    const cronDispatch = makeCronDispatch();
    const result = await completeOnboarding(checkinValues, '/workspace', asSendTarget, cronDispatch);

    expect(executeCronAction).toHaveBeenCalledOnce();
    expect(executeCronAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cronCreate',
        name: 'Morning Check-in',
        schedule: '0 8 * * *',
        timezone: 'America/New_York',
        channel: 'ch-1',
      }),
      cronDispatch.actionCtx,
      cronDispatch.cronCtx,
    );
    expect(result.cronResult).toEqual({ ok: true, summary: 'Cron created' });
  });

  it('cron dispatch failure is logged and does not fail onboarding', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());
    const executeCronAction = await getExecuteCronAction();
    executeCronAction.mockRejectedValue(new Error('Forum not found'));

    const { send, asSendTarget } = makeSendTarget();
    const cronDispatch = makeCronDispatch();
    const result = await completeOnboarding(checkinValues, '/workspace', asSendTarget, cronDispatch);

    // Onboarding still succeeds — success message sent
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].content).toContain('All set');

    // Error is logged
    expect(cronDispatch.log.warn).toHaveBeenCalled();

    // cronResult reflects the failure
    expect(result.cronResult).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it('success message suppresses all mentions', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(makeWriteResult());

    const { send, asSendTarget } = makeSendTarget();
    await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  });

  it('error message suppresses all mentions', async () => {
    const writeWorkspaceFiles = await getWriteWorkspaceFiles();
    writeWorkspaceFiles.mockResolvedValue(
      makeWriteResult({ written: [], errors: ['boom'] }),
    );

    const { send, asSendTarget } = makeSendTarget();
    await completeOnboarding(baseValues, '/workspace', asSendTarget);

    expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
  });
});
