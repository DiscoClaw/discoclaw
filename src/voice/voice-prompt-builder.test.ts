import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extractSections,
  extractSoulEssentials,
  extractUserEssentials,
  loadVoiceIdentity,
  buildVoicePrompt,
  buildVoiceFollowUpPrompt,
  buildVoicePromptSectionEstimates,
  VOICE_INTERNAL_CONTEXT_SEPARATOR,
  VOICE_IDENTITY_MAX_CHARS,
} from './voice-prompt-builder.js';
import { VOICE_STYLE_INSTRUCTION } from './voice-style-prompt.js';
import {
  ROOT_POLICY,
  TRACKED_DEFAULTS_PREAMBLE,
  TRACKED_TOOLS_PREAMBLE,
  buildPromptPreamble,
} from '../discord/prompt-common.js';

// ---------------------------------------------------------------------------
// extractSections
// ---------------------------------------------------------------------------

describe('extractSections', () => {
  const markdown = [
    '# Title',
    '',
    '## Core Truths',
    'Be helpful.',
    'Have opinions.',
    '',
    '## Autonomy',
    'Use capabilities.',
    '',
    '## Vibe',
    '**Brevity.** Short answers.',
    '**Humor.** Be funny.',
  ].join('\n');

  it('extracts named sections', () => {
    const result = extractSections(markdown, ['Core Truths', 'Vibe']);
    expect(result).toContain('## Core Truths');
    expect(result).toContain('Be helpful.');
    expect(result).toContain('## Vibe');
    expect(result).toContain('**Brevity.** Short answers.');
  });

  it('excludes non-matching sections', () => {
    const result = extractSections(markdown, ['Core Truths']);
    expect(result).not.toContain('Autonomy');
    expect(result).not.toContain('Vibe');
  });

  it('matches headings case-insensitively', () => {
    const result = extractSections(markdown, ['core truths']);
    expect(result).toContain('## Core Truths');
    expect(result).toContain('Be helpful.');
  });

  it('returns empty string when no sections match', () => {
    const result = extractSections(markdown, ['Nonexistent']);
    expect(result).toBe('');
  });

  it('handles content with no headings', () => {
    const result = extractSections('Just some text\nwith no headings.', ['Anything']);
    expect(result).toBe('');
  });

  it('stops capturing at a top-level heading', () => {
    const md = '## Target\nContent\n# New Top Level\nNot captured';
    const result = extractSections(md, ['Target']);
    expect(result).toContain('Content');
    expect(result).not.toContain('Not captured');
  });

  it('does not capture ### sub-headings as ## sections', () => {
    const md = '### Deep Heading\nDeep content\n## Target\nTarget content';
    const result = extractSections(md, ['Deep Heading']);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractSoulEssentials / extractUserEssentials
// ---------------------------------------------------------------------------

describe('extractSoulEssentials', () => {
  const soulMd = [
    '# SOUL.md - Who You Are',
    '',
    '## Core Truths',
    'Be genuinely helpful.',
    '',
    '## Autonomy',
    'You have real capabilities.',
    '',
    '## Boundaries',
    'Private things stay private.',
    '',
    '## Vibe',
    '**Brevity.** Match the weight of the question.',
    '',
    '## Continuity',
    'Each session, you wake up fresh.',
  ].join('\n');

  it('extracts Core Truths and Vibe, drops Autonomy/Boundaries/Continuity', () => {
    const result = extractSoulEssentials(soulMd);
    expect(result).toContain('Core Truths');
    expect(result).toContain('Be genuinely helpful.');
    expect(result).toContain('Vibe');
    expect(result).toContain('Brevity');
    expect(result).not.toContain('Autonomy');
    expect(result).not.toContain('Boundaries');
    expect(result).not.toContain('Continuity');
  });
});

describe('extractUserEssentials', () => {
  const userMd = [
    '# USER.md',
    '',
    '## Basics',
    '- **Name:** Alice',
    '- **Pronouns:** she/her',
    '',
    '## Schedule',
    '- **Timezone:** US/Pacific',
    '',
    '## Preferences',
    '- **Communication style:** terse',
    '',
    '## Work',
    '- **Stack:** TypeScript',
    '',
    '## Online',
    '- **Links:** github.com',
  ].join('\n');

  it('extracts Basics and Preferences, drops Schedule/Work/Online', () => {
    const result = extractUserEssentials(userMd);
    expect(result).toContain('Basics');
    expect(result).toContain('Alice');
    expect(result).toContain('Preferences');
    expect(result).toContain('terse');
    expect(result).not.toContain('Schedule');
    expect(result).not.toContain('Work');
    expect(result).not.toContain('Online');
  });
});

// ---------------------------------------------------------------------------
// loadVoiceIdentity
// ---------------------------------------------------------------------------

describe('loadVoiceIdentity', () => {
  const tmpDir = path.join(process.cwd(), '.test-voice-identity-' + process.pid);

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when no identity files exist', async () => {
    const result = await loadVoiceIdentity(tmpDir);
    expect(result).toBe('');
  });

  it('includes SOUL.md extracted sections', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'SOUL.md'),
      '## Core Truths\nBe helpful.\n\n## Autonomy\nSkipped.\n\n## Vibe\nBe brief.',
    );
    const result = await loadVoiceIdentity(tmpDir);
    expect(result).toContain('SOUL.md');
    expect(result).toContain('Be helpful.');
    expect(result).toContain('Be brief.');
    expect(result).not.toContain('Skipped.');
  });

  it('includes IDENTITY.md in full', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'IDENTITY.md'),
      '# IDENTITY\n- **Name:** TestBot\n- **Vibe:** chill',
    );
    const result = await loadVoiceIdentity(tmpDir);
    expect(result).toContain('IDENTITY.md');
    expect(result).toContain('TestBot');
    expect(result).toContain('chill');
  });

  it('includes USER.md extracted sections', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'USER.md'),
      '## Basics\n- **Name:** Alice\n\n## Work\n- **Stack:** TS',
    );
    const result = await loadVoiceIdentity(tmpDir);
    expect(result).toContain('USER.md');
    expect(result).toContain('Alice');
    expect(result).not.toContain('Stack');
  });

  it('truncates when combined identity exceeds budget', async () => {
    // Write a very verbose SOUL.md that will exceed the budget.
    const longContent = '## Core Truths\n' + 'A'.repeat(VOICE_IDENTITY_MAX_CHARS + 500);
    await fs.writeFile(path.join(tmpDir, 'SOUL.md'), longContent);
    const result = await loadVoiceIdentity(tmpDir);
    expect(result.length).toBeLessThanOrEqual(VOICE_IDENTITY_MAX_CHARS + 20); // +20 for "(truncated)" + header
    expect(result).toContain('(truncated)');
  });

  it('combines all three files in order', async () => {
    await fs.writeFile(path.join(tmpDir, 'SOUL.md'), '## Core Truths\nSoul content.');
    await fs.writeFile(path.join(tmpDir, 'IDENTITY.md'), 'Identity content.');
    await fs.writeFile(path.join(tmpDir, 'USER.md'), '## Basics\nUser content.');

    const result = await loadVoiceIdentity(tmpDir);
    const soulIdx = result.indexOf('SOUL.md');
    const identityIdx = result.indexOf('IDENTITY.md');
    const userIdx = result.indexOf('USER.md');

    expect(soulIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(userIdx);
  });
});

// ---------------------------------------------------------------------------
// buildVoicePrompt
// ---------------------------------------------------------------------------

describe('buildVoicePrompt', () => {
  const VOICE_PROMPT_MINIMAL_MAX_CHARS = 12 * 1024;

  const baseParts = {
    identity: '--- IDENTITY.md ---\nTestBot',
    durableMemory: '',
    actionsSection: '',
    userText: 'What time is it?',
  };

  it('starts with shared preamble without tracked tools content', () => {
    const result = buildVoicePrompt(baseParts);
    const expectedPreamble = buildPromptPreamble(baseParts.identity, { skipTrackedTools: true });
    expect(result.startsWith(expectedPreamble)).toBe(true);
    expect(result).not.toContain(TRACKED_TOOLS_PREAMBLE);
  });

  it('includes identity section', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result).toContain('TestBot');
  });

  it('includes voice style instruction', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result).toContain(VOICE_STYLE_INSTRUCTION);
  });

  it('includes user text at the end', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result).toContain('What time is it?');
    // User text should be the last section.
    const lastSection = result.split('\n\n').at(-1);
    expect(lastSection).toBe('What time is it?');
  });

  it('includes separator before user text', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result).toContain('sections above are internal system context');
  });

  it('includes actions section when provided', () => {
    const result = buildVoicePrompt({
      ...baseParts,
      actionsSection: '## Discord Actions\nvoiceJoin, voiceLeave',
    });
    expect(result).toContain('## Discord Actions');
    expect(result).toContain('voiceJoin, voiceLeave');
  });

  it('omits actions section when empty', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result).not.toContain('Discord Actions');
  });

  it('includes voice system prompt when provided', () => {
    const result = buildVoicePrompt({
      ...baseParts,
      voiceSystemPrompt: 'You are a pirate.',
    });
    expect(result).toContain('You are a pirate.');
  });

  it('omits voice system prompt when undefined', () => {
    const result = buildVoicePrompt(baseParts);
    // Just verify the prompt still works without it.
    expect(result).toContain('What time is it?');
  });

  it('includes durable memory when provided', () => {
    const result = buildVoicePrompt({
      ...baseParts,
      durableMemory: 'Prefers dark mode. Owns a cat named Pixel.',
    });
    expect(result).toContain('Durable memory');
    expect(result).toContain('Prefers dark mode');
  });

  it('omits durable memory section when empty', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result).not.toContain('---\nDurable memory (user-specific notes):\n');
  });

  it('orders sections correctly: policy > tracked defaults > identity > actions > style > memory > separator > user, without tracked tools', () => {
    const result = buildVoicePrompt({
      ...baseParts,
      actionsSection: '## Discord Actions\nactions-here',
      voiceSystemPrompt: 'custom-system-prompt',
      durableMemory: 'memory-content',
    });

    const policyIdx = result.indexOf(ROOT_POLICY);
    const trackedDefaultsIdx = result.indexOf(TRACKED_DEFAULTS_PREAMBLE);
    const trackedToolsIdx = result.indexOf(TRACKED_TOOLS_PREAMBLE);
    const identityIdx = result.indexOf('TestBot');
    const actionsIdx = result.indexOf('actions-here');
    const systemPromptIdx = result.indexOf('custom-system-prompt');
    const styleIdx = result.indexOf(VOICE_STYLE_INSTRUCTION);
    const memoryIdx = result.indexOf('memory-content');
    const separatorIdx = result.indexOf('sections above are internal');
    const userIdx = result.indexOf('What time is it?');

    expect(policyIdx).toBeLessThan(trackedDefaultsIdx);
    expect(trackedToolsIdx).toBe(-1);
    expect(trackedDefaultsIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(actionsIdx);
    expect(actionsIdx).toBeLessThan(systemPromptIdx);
    expect(systemPromptIdx).toBeLessThan(styleIdx);
    expect(styleIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(separatorIdx);
    expect(separatorIdx).toBeLessThan(userIdx);
  });

  it('keeps minimal prompt under guarded budget after tracked-default injection', () => {
    const result = buildVoicePrompt(baseParts);
    expect(result.length).toBeLessThanOrEqual(VOICE_PROMPT_MINIMAL_MAX_CHARS);
  });
});

describe('buildVoicePromptSectionEstimates', () => {
  it('uses Math.ceil(chars / 4) for section token estimates', () => {
    const result = buildVoicePromptSectionEstimates({
      identity: 'abcde',
      durableMemory: 'xyz',
      voiceSystemPrompt: 's',
      actionsSection: 'abc',
      userText: 'hello world',
    });

    expect(result.sections.identity.chars).toBe(5);
    expect(result.sections.identity.estTokens).toBe(Math.ceil(5 / 4));
    expect(result.sections.actionsReference.chars).toBe(3);
    expect(result.sections.actionsReference.estTokens).toBe(Math.ceil(3 / 4));
    expect(result.sections.voiceSystemPrompt.chars).toBe(1);
    expect(result.sections.voiceSystemPrompt.estTokens).toBe(Math.ceil(1 / 4));
  });

  it('marks optional sections as excluded when empty', () => {
    const result = buildVoicePromptSectionEstimates({
      identity: '',
      durableMemory: '',
      actionsSection: '',
      userText: 'hi',
    });

    expect(result.sections.actionsReference.included).toBe(false);
    expect(result.sections.voiceSystemPrompt.included).toBe(false);
    expect(result.sections.durableMemory.included).toBe(false);
    expect(result.sections.separator.chars).toBe(VOICE_INTERNAL_CONTEXT_SEPARATOR.length);
    expect(result.sections.userText.included).toBe(true);
  });

  it('excludes tracked tools from root policy estimate', () => {
    const result = buildVoicePromptSectionEstimates({
      identity: '',
      durableMemory: '',
      actionsSection: '',
      userText: 'hi',
    });

    const rootPolicyWithoutTrackedTools = buildPromptPreamble('', { skipTrackedTools: true }).length;
    const rootPolicyWithTrackedTools = buildPromptPreamble('').length;

    expect(result.sections.rootPolicy.chars).toBe(rootPolicyWithoutTrackedTools);
    expect(result.sections.rootPolicy.estTokens).toBe(Math.ceil(rootPolicyWithoutTrackedTools / 4));
    expect(rootPolicyWithoutTrackedTools).toBeLessThan(rootPolicyWithTrackedTools);
  });
});

// ---------------------------------------------------------------------------
// buildVoiceFollowUpPrompt
// ---------------------------------------------------------------------------

describe('buildVoiceFollowUpPrompt', () => {
  it('includes style instruction', () => {
    const result = buildVoiceFollowUpPrompt({
      originalText: 'How many tasks are open?',
      actionResults: '3 tasks open',
    });
    expect(result).toContain(VOICE_STYLE_INSTRUCTION);
  });

  it('includes original user text', () => {
    const result = buildVoiceFollowUpPrompt({
      originalText: 'How many tasks are open?',
      actionResults: '3 tasks open',
    });
    expect(result).toContain('How many tasks are open?');
  });

  it('includes action results', () => {
    const result = buildVoiceFollowUpPrompt({
      originalText: 'query',
      actionResults: 'Result: 42',
    });
    expect(result).toContain('Result: 42');
  });

  it('instructs to answer using results', () => {
    const result = buildVoiceFollowUpPrompt({
      originalText: 'query',
      actionResults: 'data',
    });
    expect(result).toContain('Answer the user\'s question using these results');
  });
});
