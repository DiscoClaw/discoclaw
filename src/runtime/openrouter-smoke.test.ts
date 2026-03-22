/**
 * OpenRouter smoke tests — live source-checkout workload proof through the
 * production OpenRouter adapter.
 *
 * Opt-in only:
 *
 *   OPENROUTER_SMOKE_TEST_TIERS=capable pnpm test
 *     Run text, strict JSON, and Discord-action-shaped OpenRouter smoke cases.
 *
 *   OPENAI_COMPAT_TOOLS_ENABLED=1 OPENROUTER_SMOKE_TEST_TIERS=capable pnpm test
 *     Also run read-only Read / Glob / Grep roundtrips through the tool loop.
 *
 * Empty OPENROUTER_SMOKE_TEST_TIERS = register zero cases.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionCategoryFlags } from '../discord/actions.js';
import { parseDiscordActions } from '../discord/actions.js';
import { validateSmokeResponse, type SmokeResult } from './model-smoke-helpers.js';
import { initTierOverrides, resolveModel } from './model-tiers.js';
import { createOpenAICompatRuntime } from './openai-compat.js';
import type { EngineEvent, RuntimeAdapter } from './types.js';

type OpenRouterSmokeState = {
  runtime: RuntimeAdapter;
  apiKey: string;
  enableTools: boolean;
};

type OpenRouterSmokeWorkspace = {
  root: string;
  readFilePath: string;
  expectedReadText: string;
  expectedGlobPath: string;
  grepNeedle: string;
};

type OpenRouterSmokeCase = {
  readonly name: string;
  readonly tools: string[];
  readonly prompt: (workspace: OpenRouterSmokeWorkspace) => string;
  readonly validate: (result: SmokeResult, workspace: OpenRouterSmokeWorkspace) => void;
};

const rawTimeout = process.env.SMOKE_TEST_TIMEOUT_MS?.trim();
const TIMEOUT: number = (() => {
  if (!rawTimeout) return 60_000;
  const n = Number(rawTimeout);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SMOKE_TEST_TIMEOUT_MS must be a positive number, got "${rawTimeout}"`);
  }
  return n;
})();

function parseSmokeTierEnv(envVarName: string): string[] {
  const raw = process.env[envVarName]?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildOpenRouterSmokeRuntime(env: NodeJS.ProcessEnv = process.env): OpenRouterSmokeState {
  const apiKey = env.OPENROUTER_API_KEY?.trim() || '';
  const baseUrl = env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
  const defaultModel = env.OPENROUTER_MODEL?.trim() || 'anthropic/claude-opus-4.6';
  const enableTools = env.OPENAI_COMPAT_TOOLS_ENABLED === '1';
  const runtime = createOpenAICompatRuntime({
    id: 'openrouter',
    auth: 'api_key',
    apiKey,
    baseUrl,
    defaultModel,
    enableTools,
  });

  return { runtime, apiKey, enableTools };
}

async function createSmokeWorkspace(): Promise<OpenRouterSmokeWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openrouter-smoke-'));
  const readFilePath = path.join(root, 'read-target.txt');
  const globDir = path.join(root, 'nested');
  const globPath = path.join(globDir, 'needle.txt');
  const grepPath = path.join(root, 'grep-target.txt');
  const expectedReadText = 'OPENROUTER_SMOKE_READ_OK';
  const grepNeedle = 'OPENROUTER_SMOKE_GREP_OK';

  await fs.mkdir(globDir, { recursive: true });
  await Promise.all([
    fs.writeFile(readFilePath, expectedReadText, 'utf8'),
    fs.writeFile(globPath, 'OPENROUTER_SMOKE_GLOB_OK', 'utf8'),
    fs.writeFile(grepPath, `before\n${grepNeedle}\nafter\n`, 'utf8'),
  ]);

  return {
    root,
    readFilePath,
    expectedReadText,
    expectedGlobPath: path.relative(root, globPath),
    grepNeedle,
  };
}

function expectToolRoundtrip(events: EngineEvent[], toolName: string): void {
  expect(events.find((event) => event.type === 'tool_start' && event.name === toolName)).toBeDefined();
  expect(events.find((event) => event.type === 'tool_end' && event.name === toolName)).toMatchObject({
    type: 'tool_end',
    name: toolName,
    ok: true,
  });
}

const DISCORD_ACTION_FLAGS: ActionCategoryFlags = {
  channels: true,
  messaging: false,
  guild: false,
  moderation: false,
  polls: false,
  tasks: false,
  crons: false,
  botProfile: false,
  forge: false,
  plan: false,
  memory: false,
  defer: false,
  config: false,
  loop: false,
  canvas: false,
  imagegen: false,
  voice: false,
  spawn: false,
  archive: false,
};

function buildOpenRouterSmokeCases(enableTools: boolean): OpenRouterSmokeCase[] {
  const baseCases: OpenRouterSmokeCase[] = [
    {
      name: 'text',
      tools: [],
      prompt: () => 'Reply with exactly OPENROUTER_SMOKE_TEXT_OK and nothing else.',
      validate: (result) => {
        expect(result.text.trim()).toBe('OPENROUTER_SMOKE_TEXT_OK');
      },
    },
    {
      name: 'strict_json',
      tools: [],
      prompt: () =>
        'Return exactly this JSON object with no markdown and no extra keys: {"status":"ok","kind":"openrouter-smoke"}',
      validate: (result) => {
        expect(JSON.parse(result.text)).toEqual({ status: 'ok', kind: 'openrouter-smoke' });
      },
    },
    {
      name: 'discord_action',
      tools: [],
      prompt: () =>
        'Output exactly one Discord action block and no prose: <discord-action>{"type":"channelList"}</discord-action>',
      validate: (result) => {
        const parsed = parseDiscordActions(result.text, DISCORD_ACTION_FLAGS);
        expect(parsed.parseFailures).toBe(0);
        expect(parsed.strippedUnrecognizedTypes).toEqual([]);
        expect(parsed.cleanText).toBe('');
        expect(parsed.actions).toEqual([{ type: 'channelList' }]);
      },
    },
  ];

  if (!enableTools) return baseCases;

  return [
    ...baseCases,
    {
      name: 'read_roundtrip',
      tools: ['Read'],
      prompt: (workspace) =>
        `Use the Read tool to read the absolute file ${JSON.stringify(workspace.readFilePath)}. Reply with only the file contents exactly.`,
      validate: (result, workspace) => {
        expectToolRoundtrip(result.events, 'Read');
        expect(result.text.trim()).toBe(workspace.expectedReadText);
      },
    },
    {
      name: 'glob_roundtrip',
      tools: ['Glob'],
      prompt: () =>
        'Use the Glob tool to find the file named needle.txt anywhere under the current workspace root. Reply with only the relative path you found.',
      validate: (result, workspace) => {
        expectToolRoundtrip(result.events, 'Glob');
        expect(result.text.trim().replace(/^[.][/\\\\]/, '')).toBe(workspace.expectedGlobPath);
      },
    },
    {
      name: 'grep_roundtrip',
      tools: ['Grep'],
      prompt: (workspace) =>
        `Use the Grep tool to find the exact token ${workspace.grepNeedle} in the current workspace root. Reply with only the matching line.`,
      validate: (result, workspace) => {
        expectToolRoundtrip(result.events, 'Grep');
        expect(result.text).toContain(workspace.grepNeedle);
      },
    },
  ];
}

initTierOverrides(process.env);

const OPENROUTER_SMOKE_TIERS = parseSmokeTierEnv('OPENROUTER_SMOKE_TEST_TIERS');
const openrouterSmokeState = OPENROUTER_SMOKE_TIERS.length > 0 ? buildOpenRouterSmokeRuntime() : null;

if (OPENROUTER_SMOKE_TIERS.length === 0) {
  describe('openrouter smoke opt-in', () => {
    it.skip('set OPENROUTER_SMOKE_TEST_TIERS to enable live OpenRouter smoke cases', () => {});
  });
}

describe.each(OPENROUTER_SMOKE_TIERS)('openrouter / %s', (tierOrModel) => {
  const model = resolveModel(tierOrModel, 'openrouter');
  const { runtime, apiKey, enableTools } = openrouterSmokeState!;
  const cases = buildOpenRouterSmokeCases(enableTools);
  let workspace: OpenRouterSmokeWorkspace;

  beforeAll(async () => {
    if (!apiKey) {
      throw new Error(
        `Smoke test opt-in (OPENROUTER_SMOKE_TEST_TIERS="${process.env.OPENROUTER_SMOKE_TEST_TIERS}") ` +
          'requires OPENROUTER_API_KEY to be set.',
      );
    }
    workspace = await createSmokeWorkspace();
  });

  it.each(cases)('$name', async ({ prompt, tools, validate, name }) => {
    const events: EngineEvent[] = [];
    for await (const event of runtime.invoke({
      prompt: prompt(workspace),
      model,
      cwd: workspace.root,
      tools,
    })) {
      events.push(event);
    }

    const result = validateSmokeResponse(events, tierOrModel, name);
    expect(result.ok, `smoke failed: ${result.errorMessage}`).toBe(true);
    validate(result, workspace);
  }, TIMEOUT);
});
