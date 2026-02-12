import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

const REQUIRED_HEADINGS = [
  '# Discoclaw Plan',
  '## Metadata',
  '## Use Case',
  '## Scope',
  '## Integration Contract',
  '## Implementation Steps',
  '## Acceptance Tests',
  '## Risk, Permissions, Rollback',
  '## Handoff Prompt (Consumer Agent)',
  '## Changelog',
];

const REQUIRED_METADATA_KEYS = [
  'spec_version',
  'plan_id',
  'title',
  'author',
  'source',
  'license',
  'created_at',
  'integration_type',
  'discoclaw_min_version',
  'risk_level',
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return {};

  const lines = match[1].split('\n');
  const out: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1));
    out[key] = value;
  }
  return out;
}

function headingCount(content: string, heading: string): number {
  const re = new RegExp(`^${escapeRegExp(heading)}$`, 'gm');
  return [...content.matchAll(re)].length;
}

function getSection(content: string, heading: string): string {
  const escaped = escapeRegExp(heading);
  const re = new RegExp(`^${escaped}\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm');
  const match = content.match(re);
  return (match?.[1] ?? '').trim();
}

async function findPlanFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findPlanFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.discoclaw-plan.md')) {
      results.push(full);
    }
  }
  return results;
}

async function loadPlanFiles(): Promise<string[]> {
  const plansDir = path.join(REPO_ROOT, 'plans');
  const planFiles = await findPlanFiles(plansDir);

  return [
    path.join(REPO_ROOT, 'templates', 'plans', 'integration.discoclaw-plan.md'),
    ...planFiles,
  ];
}

describe('discoclaw-plan format', () => {
  it('enforces frontmatter metadata, required headings, and risk-gated contract rules', async () => {
    const files = await loadPlanFiles();
    expect(files.length).toBeGreaterThan(1);

    for (const filePath of files) {
      const content = await fs.readFile(filePath, 'utf-8');
      const metadata = parseFrontmatter(content);

      for (const key of REQUIRED_METADATA_KEYS) {
        expect(metadata[key], `${path.relative(REPO_ROOT, filePath)} missing frontmatter key: ${key}`).toBeTruthy();
      }

      expect(metadata.spec_version, `${path.relative(REPO_ROOT, filePath)} invalid spec_version`).toBe('1.0');
      expect(['runtime', 'actions', 'context']).toContain(metadata.integration_type);
      expect(['low', 'medium', 'high']).toContain(metadata.risk_level);

      for (const heading of REQUIRED_HEADINGS) {
        expect(headingCount(content, heading), `${path.relative(REPO_ROOT, filePath)} heading count for ${heading}`).toBe(1);
      }

      const isTemplate = path.relative(REPO_ROOT, filePath) === 'templates/plans/integration.discoclaw-plan.md';
      if (!isTemplate) {
        const expectedPlanId = path.basename(filePath, '.discoclaw-plan.md');
        expect(metadata.plan_id, `${path.relative(REPO_ROOT, filePath)} plan_id should match filename`).toBe(expectedPlanId);
      }

      const integrationSection = getSection(content, '## Integration Contract');
      const acceptanceSection = getSection(content, '## Acceptance Tests');

      const hasIntegrationJson = integrationSection.includes('```json');
      const hasAcceptanceJson = acceptanceSection.includes('```json');

      if (metadata.risk_level === 'low') {
        if (!hasIntegrationJson) {
          expect(integrationSection).toMatch(/Files to add:/);
          expect(integrationSection).toMatch(/Files to modify:/);
          expect(integrationSection).toMatch(/Environment changes:/);
          expect(integrationSection).toMatch(/Runtime behavior changes:/);
          expect(integrationSection).toMatch(/Out of scope:/);
        }

        if (!hasAcceptanceJson) {
          expect(acceptanceSection).toMatch(/Scenarios:/);
          expect(acceptanceSection).toMatch(/Required checks:/);
        }
      } else {
        expect(hasIntegrationJson, `${path.relative(REPO_ROOT, filePath)} medium/high plan missing integration JSON`).toBe(true);
        expect(hasAcceptanceJson, `${path.relative(REPO_ROOT, filePath)} medium/high plan missing acceptance JSON`).toBe(true);
      }
    }
  });
});
