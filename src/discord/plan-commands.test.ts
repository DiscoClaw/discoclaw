import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parsePlanCommand,
  handlePlanCommand,
  createPlan,
  parsePlanFileHeader,
  toSlug,
  handlePlanSkip,
  preparePlanRun,
  updatePlanFileStatus,
  listPlanFiles,
  findPlanFile,
  normalizePlanId,
  looksLikePlanId,
  closePlanIfComplete,
  NO_PHASES_SENTINEL,
} from './plan-commands.js';
import type { PlanCommand, HandlePlanCommandOpts } from './plan-commands.js';
import { TaskStore } from '../tasks/store.js';

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'plan-commands-test-'));
}

function makeStore(prefix = 'ws'): TaskStore {
  return new TaskStore({ prefix });
}

function baseOpts(overrides: Partial<HandlePlanCommandOpts> = {}): HandlePlanCommandOpts {
  return {
    workspaceCwd: '/tmp/test-workspace',
    taskStore: makeStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parsePlanCommand
// ---------------------------------------------------------------------------

describe('parsePlanCommand', () => {
  it('returns null for non-plan messages', () => {
    expect(parsePlanCommand('hello world')).toBeNull();
    expect(parsePlanCommand('!memory show')).toBeNull();
    expect(parsePlanCommand('')).toBeNull();
    // Note: '!planning something' would match because it starts with '!plan'.
    // This is fine — no other !plan* commands exist.
  });

  it('!plan with no args returns help', () => {
    expect(parsePlanCommand('!plan')).toEqual({ action: 'help', args: '' });
  });

  it('!plan with extra whitespace returns help', () => {
    expect(parsePlanCommand('  !plan  ')).toEqual({ action: 'help', args: '' });
  });

  it('parses create from description text', () => {
    expect(parsePlanCommand('!plan fix the login bug')).toEqual({
      action: 'create',
      args: 'fix the login bug',
    });
  });

  it('parses list as reserved subcommand', () => {
    expect(parsePlanCommand('!plan list')).toEqual({ action: 'list', args: '' });
  });

  it('"list" is reserved — "!plan list something" is not treated as create', () => {
    expect(parsePlanCommand('!plan list something')).toEqual({
      action: 'list',
      args: 'something',
    });
  });

  it('parses show with plan ID', () => {
    expect(parsePlanCommand('!plan show plan-001')).toEqual({
      action: 'show',
      args: 'plan-001',
    });
  });

  it('parses show with bead ID', () => {
    expect(parsePlanCommand('!plan show ws-abc-123')).toEqual({
      action: 'show',
      args: 'ws-abc-123',
    });
  });

  it('parses approve', () => {
    expect(parsePlanCommand('!plan approve plan-001')).toEqual({
      action: 'approve',
      args: 'plan-001',
    });
  });

  it('parses close', () => {
    expect(parsePlanCommand('!plan close plan-001')).toEqual({
      action: 'close',
      args: 'plan-001',
    });
  });

  it('parses help explicitly', () => {
    expect(parsePlanCommand('!plan help')).toEqual({ action: 'help', args: '' });
  });

  it('parses phases subcommand', () => {
    expect(parsePlanCommand('!plan phases plan-011')).toEqual({
      action: 'phases',
      args: 'plan-011',
    });
  });

  it('parses phases with --regenerate flag', () => {
    expect(parsePlanCommand('!plan phases --regenerate plan-011')).toEqual({
      action: 'phases',
      args: '--regenerate plan-011',
    });
  });

  it('parses run subcommand', () => {
    expect(parsePlanCommand('!plan run plan-011')).toEqual({
      action: 'run',
      args: 'plan-011',
    });
  });

  it('parses run-one subcommand', () => {
    expect(parsePlanCommand('!plan run-one plan-011')).toEqual({
      action: 'run-one',
      args: 'plan-011',
    });
  });

  it('parses skip subcommand', () => {
    expect(parsePlanCommand('!plan skip plan-011')).toEqual({
      action: 'skip',
      args: 'plan-011',
    });
  });

  it('parses cancel subcommand', () => {
    expect(parsePlanCommand('!plan cancel plan-011')).toEqual({
      action: 'cancel',
      args: 'plan-011',
    });
  });

  it('parses audit subcommand', () => {
    expect(parsePlanCommand('!plan audit plan-027')).toEqual({
      action: 'audit',
      args: 'plan-027',
    });
  });

  it('parses audit with no args', () => {
    expect(parsePlanCommand('!plan audit')).toEqual({
      action: 'audit',
      args: '',
    });
  });
});

// ---------------------------------------------------------------------------
// toSlug
// ---------------------------------------------------------------------------

describe('toSlug', () => {
  it('converts to lowercase and replaces non-alphanumeric with hyphens', () => {
    expect(toSlug('Fix the Login Bug')).toBe('fix-the-login-bug');
  });

  it('strips leading and trailing hyphens', () => {
    expect(toSlug('---hello---')).toBe('hello');
  });

  it('truncates at 50 chars without trailing hyphen', () => {
    const long = 'a'.repeat(60);
    const slug = toSlug(long);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('handles special characters and Unicode', () => {
    expect(toSlug('Add café support & résumé handling!')).toBe('add-caf-support-r-sum-handling');
  });

  it('handles empty string', () => {
    expect(toSlug('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parsePlanFileHeader
// ---------------------------------------------------------------------------

describe('parsePlanFileHeader', () => {
  it('parses a well-formed plan header', () => {
    const content = `# Plan: Add the plan command

**ID:** plan-001
**Task:** ws-test-001
**Created:** 2026-02-12
**Status:** DRAFT
**Project:** discoclaw
`;
    const header = parsePlanFileHeader(content);
    expect(header).toEqual({
      planId: 'plan-001',
      taskId: 'ws-test-001',
      status: 'DRAFT',
      title: 'Add the plan command',
      project: 'discoclaw',
      created: '2026-02-12',
    });
  });

  it('returns null when no ID field', () => {
    expect(parsePlanFileHeader('# Just some file\n\nNo plan header.')).toBeNull();
  });

  it('handles missing optional fields', () => {
    const content = `**ID:** plan-002\n`;
    const header = parsePlanFileHeader(content);
    expect(header).not.toBeNull();
    expect(header!.planId).toBe('plan-002');
    expect(header!.taskId).toBe('');
    expect(header!.title).toBe('');
  });

  it('parses task header alias as taskId', () => {
    const content = `# Plan: Alias header test

**ID:** plan-003
**Task:** ws-task-003
**Status:** DRAFT
`;
    const header = parsePlanFileHeader(content);
    expect(header).not.toBeNull();
    expect(header!.planId).toBe('plan-003');
    expect(header!.taskId).toBe('ws-task-003');
  });
});

// ---------------------------------------------------------------------------
// handlePlanCommand
// ---------------------------------------------------------------------------

describe('handlePlanCommand', () => {

  it('help — returns usage text', async () => {
    const result = await handlePlanCommand({ action: 'help', args: '' }, baseOpts());
    expect(result).toContain('!plan commands');
    expect(result).toContain('!plan list');
    expect(result).toContain('!plan show');
    expect(result).toContain('!plan approve');
    expect(result).toContain('!plan close');
  });

  it('create — writes plan file and creates bead', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'Add user authentication' },
      opts,
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('Add user authentication');

    // Verify bead was created with plan label.
    const tasks = store.list({ label: 'plan' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Add user authentication');
    expect(tasks[0]!.labels).toContain('plan');
    const beadId = tasks[0]!.id;
    expect(result).toContain(beadId);

    // Verify file was written.
    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    expect(planFile).toBeTruthy();

    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('**ID:** plan-001');
    expect(content).toContain(`**Task:** ${beadId}`);
    expect(content).toContain('**Status:** DRAFT');
  });

  it('createPlan — returns typed metadata for forge callers', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const created = await createPlan(
      { description: 'Create typed result plan', context: 'thread context' },
      opts,
    );

    expect(created.planId).toBe('plan-001');
    expect(created.fileName).toContain('create-typed-result-plan');
    expect(created.filePath).toContain(path.join(tmpDir, 'plans', created.fileName));
    expect(created.taskId).toMatch(/^ws-/);
    expect(created.displayMessage).toContain('Plan created: **plan-001**');
  });

  it('create — increments plan number based on existing files', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    // Create a pre-existing plan file.
    await fs.writeFile(
      path.join(plansDir, 'plan-003-existing.md'),
      '**ID:** plan-003\n**Status:** DONE\n',
    );

    const result = await handlePlanCommand(
      { action: 'create', args: 'New feature' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('plan-004');
  });

  it('create — sanitizes and truncates slug', async () => {
    const tmpDir = await makeTmpDir();

    await handlePlanCommand(
      { action: 'create', args: 'This is a very long description that should be truncated to fifty characters maximum for the filename' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    expect(planFile).toBeTruthy();
    // Slug portion (after plan-001-) should be <= 50 chars.
    const slug = planFile!.replace(/^plan-\d+-/, '').replace(/\.md$/, '');
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('create — returns error when no description', async () => {
    const result = await handlePlanCommand(
      { action: 'create', args: '' },
      baseOpts(),
    );
    expect(result).toContain('Usage');
  });

  it('create — handles task store create failure gracefully', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    vi.spyOn(store, 'create').mockImplementationOnce(() => { throw new Error('store error'); });

    const result = await handlePlanCommand(
      { action: 'create', args: 'Something' },
      baseOpts({ workspaceCwd: tmpDir, taskStore: store }),
    );

    expect(result).toContain('Failed to create backing task');
  });

  it('create — uses fallback template when .plan-template.md is missing', async () => {
    const tmpDir = await makeTmpDir();
    // No template file in plansDir — should use fallback.

    const result = await handlePlanCommand(
      { action: 'create', args: 'Test fallback' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('plan-001');
    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('## Objective');
    expect(content).toContain('**Status:** DRAFT');
  });

  it('create — fills {{TASK_ID}} placeholder in custom template', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });
    await fs.writeFile(
      path.join(plansDir, '.plan-template.md'),
      '# Plan: {{TITLE}}\n\n**ID:** {{PLAN_ID}}\n**Task:** {{TASK_ID}}\n**Status:** DRAFT | APPROVED\n',
    );

    const store = makeStore();
    const result = await handlePlanCommand(
      { action: 'create', args: 'Custom task placeholder' },
      baseOpts({ workspaceCwd: tmpDir, taskStore: store }),
    );

    expect(result).toContain('plan-001');
    const beadId = store.list({ label: 'plan' })[0]!.id;
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain(`**Task:** ${beadId}`);
  });

  it('create — appends context to plan file body and bead description without polluting slug or bead title', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'fix the login flow', context: 'Context (replied-to message):\n[Weston]: The login handler crashes on empty passwords.' },
      opts,
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('fix the login flow');

    // Bead title should be the raw args, not polluted with context
    const tasks = store.list({ label: 'plan' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('fix the login flow');
    expect(tasks[0]!.labels).toContain('plan');
    expect(tasks[0]!.description).toBe('Context (replied-to message):\n[Weston]: The login handler crashes on empty passwords.');

    // Slug should not contain context text
    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    expect(planFile).toBeTruthy();
    expect(planFile).not.toContain('context');
    expect(planFile).not.toContain('replied');

    // But the file body should contain the context section
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('## Context');
    expect(content).toContain('The login handler crashes on empty passwords');
  });

  it('create — trims whitespace around context before writing section and bead description', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });
    const rawContext = '\n  Trimmed context line\n  Another line  \n';
    const expectedContext = rawContext.trim();

    await handlePlanCommand(
      { action: 'create', args: 'trim context plan', context: rawContext },
      opts,
    );

    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'))!;
    const content = await fs.readFile(path.join(plansDir, planFile), 'utf-8');
    expect(content).toContain(`## Context\n\n${expectedContext}\n`);

    const tasks = store.list({ label: 'plan' });
    expect(tasks[0]!.description).toBe(expectedContext);
  });

  it('create — does not pass description when context is absent', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    await handlePlanCommand(
      { action: 'create', args: 'simple plan' },
      opts,
    );

    const tasks = store.list({ label: 'plan' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('simple plan');
    expect(tasks[0]!.description).toBeUndefined();
  });

  it('create — does not pass description when context is whitespace-only', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    await handlePlanCommand(
      { action: 'create', args: 'plan with blank context', context: '  \n  ' },
      opts,
    );

    const tasks = store.list({ label: 'plan' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('plan with blank context');
    expect(tasks[0]!.description).toBeUndefined();
  });

  it('create — truncates long context in bead description', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });
    const longContext = 'x'.repeat(5000);

    await handlePlanCommand(
      { action: 'create', args: 'plan with long context', context: longContext },
      opts,
    );

    const tasks = store.list({ label: 'plan' });
    expect(tasks[0]!.description).toHaveLength(1800);
    expect(tasks[0]!.description).toBe('x'.repeat(1800));
  });

  it('create — creates plans dir when missing', async () => {
    const tmpDir = await makeTmpDir();
    // Don't create plansDir — handlePlanCommand should create it.

    await handlePlanCommand(
      { action: 'create', args: 'First plan ever' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    const plansDir = path.join(tmpDir, 'plans');
    const stat = await fs.stat(plansDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('create — skips task store create when existingTaskId is provided', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const createSpy = vi.spyOn(store, 'create');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'fix the bug', existingTaskId: 'bead-abc' },
      opts,
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('bead-abc');
    expect(createSpy).not.toHaveBeenCalled();

    // Verify the plan file contains the existing bead ID
    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('**Task:** bead-abc');
  });

  it('create — calls addLabel when reusing existing bead', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const spy = vi.spyOn(store, 'addLabel');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    await handlePlanCommand(
      { action: 'create', args: 'test', existingTaskId: 'bead-xyz' },
      opts,
    );

    expect(spy).toHaveBeenCalledWith('bead-xyz', 'plan');
  });

  it('create — addLabel failure does not block plan creation', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    vi.spyOn(store, 'addLabel').mockImplementationOnce(() => { throw new Error('label fail'); });
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'test', existingTaskId: 'bead-fail' },
      opts,
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('bead-fail');

    // Plan file should still be created with the correct bead ID
    const plansDir = path.join(tmpDir, 'plans');
    const files = await fs.readdir(plansDir);
    const planFile = files.find((f) => f.startsWith('plan-001'));
    const content = await fs.readFile(path.join(plansDir, planFile!), 'utf-8');
    expect(content).toContain('**Task:** bead-fail');
  });

  it('create — reuses existing open bead with matching title instead of creating duplicate', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const existing = store.create({ title: 'Add user authentication', labels: ['plan'] });
    const createSpy = vi.spyOn(store, 'create');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'Add user authentication' },
      opts,
    );

    expect(result).toContain('plan-001');
    expect(result).toContain(existing.id);
    expect(createSpy).not.toHaveBeenCalled();
    // Store still has exactly the one pre-existing task
    expect(store.list({ label: 'plan' })).toHaveLength(1);
  });

  it('create — dedup is case-insensitive and trims whitespace', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const existing = store.create({ title: '  Fix The Bug  ', labels: ['plan'] });
    const createSpy = vi.spyOn(store, 'create');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'fix the bug' },
      opts,
    );

    expect(result).toContain(existing.id);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('create — does not reuse closed beads with matching title', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const closed = store.create({ title: 'Add user authentication', labels: ['plan'] });
    store.close(closed.id, 'done');
    const createSpy = vi.spyOn(store, 'create');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'Add user authentication' },
      opts,
    );

    expect(createSpy).toHaveBeenCalled();
    // A new task was created (total 2 in store including the closed one)
    expect(store.list({ status: 'all' })).toHaveLength(2);
    // Result contains the new task's ID
    const newTask = store.list({ label: 'plan' })[0]!;
    expect(result).toContain(newTask.id);
  });

  it('create — creates new bead when no title match exists', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    store.create({ title: 'Something else entirely', labels: ['plan'] });
    const createSpy = vi.spyOn(store, 'create');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'Add user authentication' },
      opts,
    );

    expect(createSpy).toHaveBeenCalled();
    expect(store.list({ label: 'plan' })).toHaveLength(2);
    const newTask = store.list({ label: 'plan' }).find((t) => t.title === 'Add user authentication')!;
    expect(result).toContain(newTask.id);
  });

  it('create — dedup reuses in_progress bead with matching title', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore();
    const existing = store.create({ title: 'Add user authentication', labels: ['plan'] });
    store.update(existing.id, { status: 'in_progress' });
    const createSpy = vi.spyOn(store, 'create');
    const opts = baseOpts({ workspaceCwd: tmpDir, taskStore: store });

    const result = await handlePlanCommand(
      { action: 'create', args: 'Add user authentication' },
      opts,
    );

    expect(result).toContain(existing.id);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('list — shows active plans as bullet list', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-alpha.md'),
      '# Plan: Alpha\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** DRAFT\n**Project:** test\n**Created:** 2026-01-01\n',
    );
    await fs.writeFile(
      path.join(plansDir, 'plan-002-beta.md'),
      '# Plan: Beta\n\n**ID:** plan-002\n**Task:** ws-002\n**Status:** APPROVED\n**Project:** test\n**Created:** 2026-01-02\n',
    );

    const result = await handlePlanCommand(
      { action: 'list', args: '' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('DRAFT');
    expect(result).toContain('Alpha');
    expect(result).toContain('plan-002');
    expect(result).toContain('APPROVED');
    expect(result).toContain('Beta');
  });

  it('list — returns message when no plans', async () => {
    const tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, 'plans'), { recursive: true });

    const result = await handlePlanCommand(
      { action: 'list', args: '' },
      baseOpts({ workspaceCwd: tmpDir }),
    );
    expect(result).toBe('No plans found.');
  });

  it('list — returns message when plans dir missing', async () => {
    const tmpDir = await makeTmpDir();

    const result = await handlePlanCommand(
      { action: 'list', args: '' },
      baseOpts({ workspaceCwd: tmpDir }),
    );
    expect(result).toBe('No plans directory found.');
  });

  it('show — finds plan by plan ID', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature for plan commands.',
        '',
        '## Audit Log',
        '',
        '### Review 1',
        '',
        '#### Verdict',
        '',
        '**Ready with minor revisions.**',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('Test feature');
    expect(result).toContain('DRAFT');
    expect(result).toContain('Build the test feature');
    expect(result).toContain('Ready with minor revisions');
  });

  it('show — extracts **Verdict:** inline bold format from audit log', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '### Round 1',
        '',
        'Some audit commentary.',
        '',
        '**Verdict:** Ready to approve. The plan is solid.',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Ready to approve. The plan is solid.');
    expect(result).not.toContain('(no audit yet)');
  });

  it('show — picks latest verdict when multiple audit rounds exist', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '### Round 1',
        '',
        '**Verdict:** Needs revision. Missing error handling.',
        '',
        '### Round 2',
        '',
        '**Verdict:** Ready to approve. All issues addressed.',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Ready to approve. All issues addressed.');
    expect(result).not.toContain('Needs revision');
  });

  it('show — handles mixed legacy #### Verdict and **Verdict:** formats', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '### Round 1 (legacy)',
        '',
        '#### Verdict',
        '',
        '**Old format verdict.**',
        '',
        '### Round 2 (new)',
        '',
        '**Verdict:** Ready to approve. Updated format.',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Ready to approve. Updated format.');
    expect(result).not.toContain('Old format verdict');
  });

  it('show — returns "(no audit yet)" when audit log section has no verdicts', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '_Audit notes go here._',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('(no audit yet)');
  });

  it('show — ignores **Verdict:** inside fenced code blocks', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '### Round 1',
        '',
        'Here is an example of what the auditor writes:',
        '',
        '```',
        '**Verdict:** This is inside a code block and should be ignored.',
        '```',
        '',
        '**Verdict:** Ready to approve. Real verdict outside the fence.',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Ready to approve. Real verdict outside the fence.');
    expect(result).not.toContain('inside a code block');
  });

  it('show — ignores mid-line **Verdict:** in prose after the real verdict', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '### Round 1',
        '',
        '**Verdict:** Ready to approve. The plan is solid.',
        '',
        'Note: Use **Verdict:** [text] format for future audits. This mid-line mention should not override the real verdict above.',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Ready to approve. The plan is solid.');
    expect(result).not.toContain('future audits');
  });

  it('show — captures multi-line legacy #### Verdict blocks', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      [
        '# Plan: Test feature',
        '',
        '**ID:** plan-001',
        '**Task:** ws-001',
        '**Status:** DRAFT',
        '**Project:** discoclaw',
        '**Created:** 2026-02-12',
        '',
        '---',
        '',
        '## Objective',
        '',
        'Build the test feature.',
        '',
        '## Audit Log',
        '',
        '#### Verdict',
        '',
        '**Ready with minor revisions.**',
        'Some additional detail about the verdict.',
        '',
        '---',
      ].join('\n'),
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Ready with minor revisions.');
    expect(result).toContain('additional detail');
  });

  it('show — finds plan by bead ID', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-abc-123\n**Status:** DRAFT\n**Project:** test\n**Created:** 2026-01-01\n\n---\n\n## Objective\n\nSome objective.\n\n## Risks\n',
    );

    const result = await handlePlanCommand(
      { action: 'show', args: 'ws-abc-123' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('plan-001');
    expect(result).toContain('ws-abc-123');
  });

  it('show — returns not found for unknown ID', async () => {
    const tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, 'plans'), { recursive: true });

    const result = await handlePlanCommand(
      { action: 'show', args: 'plan-999' },
      baseOpts({ workspaceCwd: tmpDir }),
    );
    expect(result).toContain('Plan not found');
  });

  it('show — returns usage when no args', async () => {
    const result = await handlePlanCommand(
      { action: 'show', args: '' },
      baseOpts(),
    );
    expect(result).toContain('Usage');
  });

  it('approve — updates status to APPROVED and bead to in_progress', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const filePath = path.join(plansDir, 'plan-001-test.md');
    await fs.writeFile(
      filePath,
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** DRAFT\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const store = makeStore();
    const updateSpy = vi.spyOn(store, 'update');
    const result = await handlePlanCommand(
      { action: 'approve', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir, taskStore: store }),
    );

    expect(result).toContain('approved');

    // Verify file was updated.
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('**Status:** APPROVED');
    expect(content).not.toContain('**Status:** DRAFT');

    // Verify task store update was attempted with in_progress.
    expect(updateSpy).toHaveBeenCalledWith('ws-001', { status: 'in_progress' });
  });

  it('approve — returns usage when no args', async () => {
    const result = await handlePlanCommand(
      { action: 'approve', args: '' },
      baseOpts(),
    );
    expect(result).toContain('Usage');
  });

  it('close — updates status to CLOSED and closes bead', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const filePath = path.join(plansDir, 'plan-001-test.md');
    await fs.writeFile(
      filePath,
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** APPROVED\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const store = makeStore();
    const closeSpy = vi.spyOn(store, 'close');
    const result = await handlePlanCommand(
      { action: 'close', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir, taskStore: store }),
    );

    expect(result).toContain('closed');

    // Verify file was updated.
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('**Status:** CLOSED');

    // Verify task store close was attempted.
    expect(closeSpy).toHaveBeenCalledWith('ws-001', 'Plan closed');
  });

  it('close — returns usage when no args', async () => {
    const result = await handlePlanCommand(
      { action: 'close', args: '' },
      baseOpts(),
    );
    expect(result).toContain('Usage');
  });

  it('close — returns not found for unknown ID', async () => {
    const tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, 'plans'), { recursive: true });

    const result = await handlePlanCommand(
      { action: 'close', args: 'plan-999' },
      baseOpts({ workspaceCwd: tmpDir }),
    );
    expect(result).toContain('Plan not found');
  });

  it('phases — returns usage when no args', async () => {
    const result = await handlePlanCommand(
      { action: 'phases', args: '' },
      baseOpts(),
    );
    expect(result).toContain('Usage');
  });

  it('phases — returns not found for unknown plan', async () => {
    const tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, 'plans'), { recursive: true });

    const result = await handlePlanCommand(
      { action: 'phases', args: 'plan-999' },
      baseOpts({ workspaceCwd: tmpDir }),
    );
    expect(result).toContain('Plan not found');
  });

  it('phases — generates and returns phases checklist', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test phases',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add the foo module',
      '- `src/foo.test.ts` — add tests',
      '',
    ].join('\n');

    await fs.writeFile(path.join(plansDir, 'plan-001-test-phases.md'), planContent);

    const result = await handlePlanCommand(
      { action: 'phases', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('Phases for plan-001');
    expect(result).toContain('phase-');
    // Phases file should have been created
    const phasesFile = path.join(plansDir, 'plan-001-phases.md');
    const exists = await fs.access(phasesFile).then(() => true, () => false);
    expect(exists).toBe(true);
  });

  it('phases — reads existing phases file without regenerating', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add the foo module',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    // First call generates phases
    await handlePlanCommand(
      { action: 'phases', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    // Read the generated file to confirm it exists
    const phasesPath = path.join(plansDir, 'plan-001-phases.md');
    const content1 = await fs.readFile(phasesPath, 'utf-8');

    // Second call should read existing, not regenerate
    const result2 = await handlePlanCommand(
      { action: 'phases', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    const content2 = await fs.readFile(phasesPath, 'utf-8');
    expect(content1).toBe(content2);
    expect(result2).toContain('Phases for plan-001');
  });

  it('help — includes phases, run, skip, audit commands', async () => {
    const result = await handlePlanCommand({ action: 'help', args: '' }, baseOpts());
    expect(result).toContain('!plan phases');
    expect(result).toContain('!plan run');
    expect(result).toContain('!plan skip');
    expect(result).toContain('!plan audit');
  });

  it('approve — blocks when plan is IMPLEMENTING', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** IMPLEMENTING\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await handlePlanCommand(
      { action: 'approve', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('currently being implemented');
    expect(result).toContain('!plan cancel plan-001');
  });

  it('close — blocks when plan is IMPLEMENTING', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** IMPLEMENTING\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await handlePlanCommand(
      { action: 'close', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    expect(result).toContain('currently being implemented');
    expect(result).toContain('!plan cancel plan-001');
  });
});

// ---------------------------------------------------------------------------
// handlePlanSkip
// ---------------------------------------------------------------------------

describe('handlePlanSkip', () => {
  it('returns not found for unknown plan', async () => {
    const tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, 'plans'), { recursive: true });

    const result = await handlePlanSkip('plan-999', baseOpts({ workspaceCwd: tmpDir }));
    expect(result).toContain('Plan not found');
  });

  it('returns error when no phases file exists', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** APPROVED\n**Project:** discoclaw\n**Created:** 2026-02-12\n',
    );

    const result = await handlePlanSkip('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect(result).toContain('No phases file found');
  });

  it('returns nothing to skip when no failed/in-progress phases', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    // Generate phases (all will be pending)
    await handlePlanCommand(
      { action: 'phases', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    const result = await handlePlanSkip('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect(result).toBe('Nothing to skip.');
  });

  it('skips a failed phase and writes to disk', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '- `src/bar.ts` — add bar',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    // Generate phases
    await handlePlanCommand(
      { action: 'phases', args: 'plan-001' },
      baseOpts({ workspaceCwd: tmpDir }),
    );

    // Manually edit phases file to mark phase-1 as failed
    const phasesPath = path.join(plansDir, 'plan-001-phases.md');
    const phasesJsonPath = path.join(plansDir, 'plan-001-phases.json');
    let phasesContent = await fs.readFile(phasesPath, 'utf-8');
    phasesContent = phasesContent.replace('**Status:** pending', '**Status:** failed');
    await fs.writeFile(phasesPath, phasesContent);
    const phasesJson = JSON.parse(await fs.readFile(phasesJsonPath, 'utf-8'));
    const firstPending = phasesJson.phases.find((p: any) => p.status === 'pending');
    if (firstPending) firstPending.status = 'failed';
    await fs.writeFile(phasesJsonPath, JSON.stringify(phasesJson, null, 2) + '\n', 'utf-8');

    const result = await handlePlanSkip('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect(result).toContain('Skipped');
    expect(result).toContain('was failed');

    // Verify the file was updated
    const updatedContent = await fs.readFile(phasesPath, 'utf-8');
    expect(updatedContent).toContain('**Status:** skipped');
  });
});

// ---------------------------------------------------------------------------
// preparePlanRun
// ---------------------------------------------------------------------------

describe('preparePlanRun', () => {
  it('returns error for unknown plan', async () => {
    const tmpDir = await makeTmpDir();
    await fs.mkdir(path.join(tmpDir, 'plans'), { recursive: true });

    const result = await preparePlanRun('plan-999', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Plan not found');
    }
  });

  it('rejects DRAFT plans with status gate error', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** DRAFT\n**Project:** discoclaw\n**Created:** 2026-02-12\n',
    );

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('DRAFT');
      expect(result.error).toContain('APPROVED or IMPLEMENTING');
    }
  });

  it('rejects REVIEW plans with status gate error', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** REVIEW\n**Project:** discoclaw\n**Created:** 2026-02-12\n',
    );

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('REVIEW');
    }
  });

  it('rejects CLOSED plans with status gate error', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** CLOSED\n**Project:** discoclaw\n**Created:** 2026-02-12\n',
    );

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('CLOSED');
    }
  });

  it('allows IMPLEMENTING plans through status gate', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** IMPLEMENTING',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(false);
  });

  it('generates phases file if missing', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.nextPhase).toBeDefined();
      expect(result.planContent).toBe(planContent);
      expect(result.phasesFilePath).toContain('plan-001-phases.md');
    }

    // Verify phases file was created
    const phasesExists = await fs.access(path.join(plansDir, 'plan-001-phases.md')).then(() => true, () => false);
    expect(phasesExists).toBe(true);
  });

  it('detects stale phases and returns error', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    // Generate phases
    await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));

    // Now modify the plan content (make it stale)
    const modifiedContent = planContent + '\n\n## Extra section\n';
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), modifiedContent);

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('changed since phases');
    }
  });

  it('returns next phase info when ready', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '- `src/bar.ts` — add bar',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.nextPhase.status).toBe('pending');
      expect(result.nextPhase.kind).toBeDefined();
      expect(result.planFilePath).toContain('plan-001-test.md');
    }
  });

  it('returns error with NO_PHASES_SENTINEL when all phases are done', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const planContent = [
      '# Plan: Test',
      '',
      '**ID:** plan-001',
      '**Task:** ws-001',
      '**Status:** APPROVED',
      '**Project:** discoclaw',
      '**Created:** 2026-02-12',
      '',
      '## Changes',
      '',
      '- `src/foo.ts` — add foo',
      '',
    ].join('\n');
    await fs.writeFile(path.join(plansDir, 'plan-001-test.md'), planContent);

    // Generate phases then mark them all done
    await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    const phasesPath = path.join(plansDir, 'plan-001-phases.md');
    const phasesJsonPath = path.join(plansDir, 'plan-001-phases.json');
    let content = await fs.readFile(phasesPath, 'utf-8');
    content = content.replace(/\*\*Status:\*\* pending/g, '**Status:** done');
    await fs.writeFile(phasesPath, content);
    const phasesJson = JSON.parse(await fs.readFile(phasesJsonPath, 'utf-8'));
    for (const phase of phasesJson.phases) {
      phase.status = 'done';
    }
    await fs.writeFile(phasesJsonPath, JSON.stringify(phasesJson, null, 2) + '\n', 'utf-8');

    const result = await preparePlanRun('plan-001', baseOpts({ workspaceCwd: tmpDir }));
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain(NO_PHASES_SENTINEL);
      expect(result.error.startsWith(NO_PHASES_SENTINEL)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// updatePlanFileStatus
// ---------------------------------------------------------------------------

describe('updatePlanFileStatus', () => {
  it('updates the status field in a plan file', async () => {
    const tmpDir = await makeTmpDir();
    const filePath = path.join(tmpDir, 'plan-001-test.md');
    await fs.writeFile(
      filePath,
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** DRAFT\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    await updatePlanFileStatus(filePath, 'APPROVED');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('**Status:** APPROVED');
    expect(content).not.toContain('**Status:** DRAFT');
  });
});

// ---------------------------------------------------------------------------
// listPlanFiles
// ---------------------------------------------------------------------------

describe('listPlanFiles', () => {
  it('returns parsed headers for all plan files', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-alpha.md'),
      '# Plan: Alpha\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** DRAFT\n**Project:** test\n**Created:** 2026-01-01\n',
    );
    await fs.writeFile(
      path.join(plansDir, 'plan-002-beta.md'),
      '# Plan: Beta\n\n**ID:** plan-002\n**Task:** ws-002\n**Status:** IMPLEMENTING\n**Project:** test\n**Created:** 2026-01-02\n',
    );

    const results = await listPlanFiles(plansDir);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.header.planId).sort()).toEqual(['plan-001', 'plan-002']);
    expect(results[0]!.filePath).toContain('plans/');
  });

  it('skips dot-prefixed files and non-.md files', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(path.join(plansDir, '.plan-template.md'), '**ID:** template\n');
    await fs.writeFile(path.join(plansDir, 'notes.txt'), 'not a plan');
    await fs.writeFile(
      path.join(plansDir, 'plan-001-real.md'),
      '# Plan: Real\n\n**ID:** plan-001\n**Status:** DRAFT\n',
    );

    const results = await listPlanFiles(plansDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.header.planId).toBe('plan-001');
  });

  it('returns empty array when directory does not exist', async () => {
    const results = await listPlanFiles('/tmp/nonexistent-plans-dir-12345');
    expect(results).toEqual([]);
  });

  it('skips files that fail to parse', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(path.join(plansDir, 'bad-plan.md'), 'No valid header here');
    await fs.writeFile(
      path.join(plansDir, 'plan-001-good.md'),
      '# Plan: Good\n\n**ID:** plan-001\n**Status:** DRAFT\n',
    );

    const results = await listPlanFiles(plansDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.header.planId).toBe('plan-001');
  });
});

// ---------------------------------------------------------------------------
// normalizePlanId
// ---------------------------------------------------------------------------

describe('normalizePlanId', () => {
  it('normalizes bare "031" to "plan-031"', () => {
    expect(normalizePlanId('031')).toBe('plan-031');
  });

  it('normalizes bare "31" to "plan-031"', () => {
    expect(normalizePlanId('31')).toBe('plan-031');
  });

  it('normalizes bare "1" to "plan-001"', () => {
    expect(normalizePlanId('1')).toBe('plan-001');
  });

  it('normalizes "plan-31" to "plan-031"', () => {
    expect(normalizePlanId('plan-31')).toBe('plan-031');
  });

  it('normalizes "plan-1" to "plan-001"', () => {
    expect(normalizePlanId('plan-1')).toBe('plan-001');
  });

  it('passes through "plan-031" as "plan-031"', () => {
    expect(normalizePlanId('plan-031')).toBe('plan-031');
  });

  it('returns null for bead IDs', () => {
    expect(normalizePlanId('workspace-abc')).toBeNull();
  });

  it('returns null for descriptions', () => {
    expect(normalizePlanId('add rate limiting')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// looksLikePlanId
// ---------------------------------------------------------------------------

describe('looksLikePlanId', () => {
  it('returns true for bare numbers', () => {
    expect(looksLikePlanId('031')).toBe(true);
    expect(looksLikePlanId('31')).toBe(true);
    expect(looksLikePlanId('1')).toBe(true);
  });

  it('returns true for plan-N patterns', () => {
    expect(looksLikePlanId('plan-031')).toBe(true);
    expect(looksLikePlanId('plan-31')).toBe(true);
  });

  it('returns false for descriptions', () => {
    expect(looksLikePlanId('add rate limiting')).toBe(false);
    expect(looksLikePlanId('fix the bug')).toBe(false);
    expect(looksLikePlanId('31 flavors of ice cream')).toBe(false);
  });

  it('returns false for bead IDs', () => {
    expect(looksLikePlanId('workspace-abc')).toBe(false);
    expect(looksLikePlanId('ws-test-001')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findPlanFile — bare-number resolution
// ---------------------------------------------------------------------------

describe('findPlanFile — bare-number resolution', () => {
  it('resolves bare number "031" to "plan-031"', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-031-test.md'),
      '# Plan: Test\n\n**ID:** plan-031\n**Task:** ws-001\n**Status:** REVIEW\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await findPlanFile(plansDir, '031');
    expect(result).not.toBeNull();
    expect(result!.header.planId).toBe('plan-031');
  });

  it('resolves unpadded number "31" to "plan-031"', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-031-test.md'),
      '# Plan: Test\n\n**ID:** plan-031\n**Task:** ws-001\n**Status:** REVIEW\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await findPlanFile(plansDir, '31');
    expect(result).not.toBeNull();
    expect(result!.header.planId).toBe('plan-031');
  });

  it('resolves "plan-31" to "plan-031"', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-031-test.md'),
      '# Plan: Test\n\n**ID:** plan-031\n**Task:** ws-001\n**Status:** REVIEW\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await findPlanFile(plansDir, 'plan-31');
    expect(result).not.toBeNull();
    expect(result!.header.planId).toBe('plan-031');
  });

  it('still resolves full "plan-031" format', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-031-test.md'),
      '# Plan: Test\n\n**ID:** plan-031\n**Task:** ws-001\n**Status:** REVIEW\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await findPlanFile(plansDir, 'plan-031');
    expect(result).not.toBeNull();
    expect(result!.header.planId).toBe('plan-031');
  });

  it('still resolves bead ID', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-031-test.md'),
      '# Plan: Test\n\n**ID:** plan-031\n**Task:** ws-special-bead\n**Status:** REVIEW\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await findPlanFile(plansDir, 'ws-special-bead');
    expect(result).not.toBeNull();
    expect(result!.header.planId).toBe('plan-031');
  });

  it('returns null for number that does not match any plan', async () => {
    const tmpDir = await makeTmpDir();
    const plansDir = path.join(tmpDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    await fs.writeFile(
      path.join(plansDir, 'plan-001-test.md'),
      '# Plan: Test\n\n**ID:** plan-001\n**Task:** ws-001\n**Status:** REVIEW\n**Project:** test\n**Created:** 2026-01-01\n',
    );

    const result = await findPlanFile(plansDir, '999');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// closePlanIfComplete
// ---------------------------------------------------------------------------

function makePhasesFile(statuses: string[]): string {
  const lines: string[] = [];
  lines.push('# Phases: plan-001 — workspace/plans/plan-001-test.md');
  lines.push('Created: 2026-02-16T00:00:00.000Z');
  lines.push('Updated: 2026-02-16T00:00:00.000Z');
  lines.push('Plan hash: abc123');
  lines.push('');
  for (let i = 0; i < statuses.length; i++) {
    lines.push(`## phase-${i + 1}: Phase ${i + 1}`);
    lines.push(`**Kind:** implement`);
    lines.push(`**Status:** ${statuses[i]}`);
    lines.push(`**Context:** (none)`);
    lines.push(`**Depends on:** (none)`);
    lines.push('');
    lines.push('Do the thing.');
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function makePlanFile(opts: { status: string; beadId?: string }): string {
  const lines = [
    '# Plan: Test',
    '',
    '**ID:** plan-001',
  ];
  // Only include Bead line if beadId is provided (non-empty).
  // parsePlanFileHeader's regex misbehaves on empty **Task:** lines.
  const beadId = opts.beadId ?? 'ws-001';
  if (beadId) lines.push(`**Task:** ${beadId}`);
  lines.push(`**Status:** ${opts.status}`);
  lines.push('**Project:** discoclaw');
  lines.push('**Created:** 2026-02-12');
  return lines.join('\n');
}

function makeAcquireLock(): { acquireLock: () => Promise<() => void>; lockCalls: number; unlockCalls: number } {
  const state = { lockCalls: 0, unlockCalls: 0 };
  const acquireLock = async () => {
    state.lockCalls++;
    return () => { state.unlockCalls++; };
  };
  return { acquireLock, ...state, get lockCalls() { return state.lockCalls; }, get unlockCalls() { return state.unlockCalls; } };
}

describe('closePlanIfComplete', () => {
  it('closes plan and bead when all phases are done', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const store = makeStore();
    const closeSpy = vi.spyOn(store, 'close');
    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, store, lock.acquireLock);

    expect(result).toEqual({ closed: true, reason: 'all_phases_complete' });

    // Plan file should now be CLOSED
    const content = await fs.readFile(planPath, 'utf-8');
    expect(content).toContain('**Status:** CLOSED');

    // Bead close attempted on the task store
    expect(closeSpy).toHaveBeenCalledWith('ws-001', 'All phases complete');

    // Lock acquired and released exactly once
    expect(lock.lockCalls).toBe(1);
    expect(lock.unlockCalls).toBe(1);
  });

  it('closes plan when all phases are skipped', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['skipped', 'skipped']));
    await fs.writeFile(planPath, makePlanFile({ status: 'IMPLEMENTING' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: true, reason: 'all_phases_complete' });
  });

  it('closes plan with mix of done and skipped phases', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'skipped', 'done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: true, reason: 'all_phases_complete' });
  });

  it('returns not_all_complete when some phases are pending', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'pending']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: false, reason: 'not_all_complete' });

    // Plan status should be unchanged
    const content = await fs.readFile(planPath, 'utf-8');
    expect(content).toContain('**Status:** APPROVED');

    // Lock should still be released
    expect(lock.unlockCalls).toBe(1);
  });

  it('returns not_all_complete when a phase is in-progress', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'in-progress']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: false, reason: 'not_all_complete' });
  });

  it('returns not_all_complete when a phase is failed', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'failed']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: false, reason: 'not_all_complete' });
  });

  it('returns wrong_status for DRAFT plans', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'DRAFT' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: false, reason: 'wrong_status' });

    // Plan should remain DRAFT
    const content = await fs.readFile(planPath, 'utf-8');
    expect(content).toContain('**Status:** DRAFT');
  });

  it('returns wrong_status for CLOSED plans', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'CLOSED' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: false, reason: 'wrong_status' });
  });

  it('returns read_error when phases file does not exist', async () => {
    const tmpDir = await makeTmpDir();
    const planPath = path.join(tmpDir, 'plan.md');
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const lock = makeAcquireLock();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await closePlanIfComplete(
      path.join(tmpDir, 'nonexistent-phases.md'),
      planPath,
      makeStore(),
      lock.acquireLock,
      log,
    );

    expect(result).toEqual({ closed: false, reason: 'read_error' });
    expect(log.warn).toHaveBeenCalled();
    expect(lock.unlockCalls).toBe(1);
  });

  it('returns read_error when phases file is malformed', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, 'this is not a valid phases file');
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const lock = makeAcquireLock();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock, log);

    expect(result).toEqual({ closed: false, reason: 'read_error' });
    expect(log.warn).toHaveBeenCalled();
    expect(lock.unlockCalls).toBe(1);
  });

  it('returns read_error when plan file does not exist', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done']));

    const lock = makeAcquireLock();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await closePlanIfComplete(
      phasesPath,
      path.join(tmpDir, 'nonexistent-plan.md'),
      makeStore(),
      lock.acquireLock,
      log,
    );

    expect(result).toEqual({ closed: false, reason: 'read_error' });
    expect(lock.unlockCalls).toBe(1);
  });

  it('skips bead close when beadId is empty', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED', beadId: '' }));

    const store = makeStore();
    const closeSpy = vi.spyOn(store, 'close');
    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, store, lock.acquireLock);

    expect(result).toEqual({ closed: true, reason: 'all_phases_complete' });
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('still closes plan when task store close fails (best-effort)', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    const store = makeStore();
    vi.spyOn(store, 'close').mockImplementationOnce(() => { throw new Error('bead not found'); });

    const lock = makeAcquireLock();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await closePlanIfComplete(phasesPath, planPath, store, lock.acquireLock, log);

    expect(result).toEqual({ closed: true, reason: 'all_phases_complete' });

    // Plan should still be CLOSED
    const content = await fs.readFile(planPath, 'utf-8');
    expect(content).toContain('**Status:** CLOSED');

    // Warning should have been logged
    expect(log.warn).toHaveBeenCalled();
  });

  it('releases lock even when updatePlanFileStatus throws', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    // Plan file path that exists for header parsing but will fail on write
    // (updatePlanFileStatus reads then writes — make the path a directory to force write failure)
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'APPROVED' }));

    // Make plan file read-only to cause updatePlanFileStatus to fail on write
    await fs.chmod(planPath, 0o444);

    const lock = makeAcquireLock();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock, log),
    ).rejects.toThrow();

    // Lock must still be released
    expect(lock.unlockCalls).toBe(1);

    // Restore permissions for cleanup
    await fs.chmod(planPath, 0o644);
  });

  it('accepts IMPLEMENTING status for auto-close', async () => {
    const tmpDir = await makeTmpDir();
    const phasesPath = path.join(tmpDir, 'phases.md');
    const planPath = path.join(tmpDir, 'plan.md');

    await fs.writeFile(phasesPath, makePhasesFile(['done', 'done']));
    await fs.writeFile(planPath, makePlanFile({ status: 'IMPLEMENTING' }));

    const lock = makeAcquireLock();
    const result = await closePlanIfComplete(phasesPath, planPath, makeStore(), lock.acquireLock);

    expect(result).toEqual({ closed: true, reason: 'all_phases_complete' });

    const content = await fs.readFile(planPath, 'utf-8');
    expect(content).toContain('**Status:** CLOSED');
  });
});
