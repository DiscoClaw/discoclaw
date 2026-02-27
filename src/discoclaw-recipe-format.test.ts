import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

const REQUIRED_HEADINGS = [
  '# DiscoClaw Recipe',
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

const processor = unified().use(remarkParse);

function parseMarkdown(content: string) {
  return processor.parse(content);
}

function getHeadingLevel(heading: string): number {
  const match = heading.match(/^(#{1,6})\s/);
  return match ? match[1].length : 0;
}

function getHeadingTextFromString(heading: string): string {
  return heading.replace(/^#{1,6}\s+/, '');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNodeText(node: any): string {
  if (node.type === 'text') return node.value as string;
  if ('children' in node) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (node.children as any[]).map(getNodeText).join('');
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countHeadings(tree: ReturnType<typeof parseMarkdown>, heading: string): number {
  const level = getHeadingLevel(heading);
  const text = getHeadingTextFromString(heading);
  let count = 0;
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === level && getNodeText(node) === text) {
      count++;
    }
  }
  return count;
}

// Uses AST position offsets to slice raw content — fixes the \Z regex bug where
// the last section was unreliable. Collects all nodes after the target heading
// up to the next heading of equal or lesser depth (or end of document).
function getSectionContent(content: string, tree: ReturnType<typeof parseMarkdown>, heading: string): string {
  const level = getHeadingLevel(heading);
  const text = getHeadingTextFromString(heading);

  let sectionStart = -1;
  let sectionEnd = content.length;

  for (const node of tree.children) {
    if (node.type === 'heading') {
      if (sectionStart === -1) {
        if (node.depth === level && getNodeText(node) === text) {
          sectionStart = node.position!.end.offset!;
        }
      } else if (node.depth <= level) {
        sectionEnd = node.position!.start.offset!;
        break;
      }
    }
  }

  if (sectionStart === -1) return '';
  return content.slice(sectionStart, sectionEnd).trim();
}

async function findRecipeFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findRecipeFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.discoclaw-recipe.md')) {
      results.push(full);
    }
  }
  return results;
}

async function loadRecipeFiles(): Promise<string[]> {
  const recipesDir = path.join(REPO_ROOT, 'recipes');
  const recipeFiles = await findRecipeFiles(recipesDir);

  return [
    path.join(REPO_ROOT, 'templates', 'recipes', 'integration.discoclaw-recipe.md'),
    ...recipeFiles,
  ];
}

describe('discoclaw-recipe format', async () => {
  const files = await loadRecipeFiles();
  expect(files.length).toBeGreaterThan(1);

  const fileEntries = files.map((f) => [path.relative(REPO_ROOT, f), f] as [string, string]);

  describe.each(fileEntries)('%s', (relPath, filePath) => {
    let content: string;
    let tree: ReturnType<typeof parseMarkdown>;
    let metadata: Record<string, unknown>;

    beforeAll(async () => {
      content = await fs.readFile(filePath, 'utf-8');
      tree = parseMarkdown(content);
      metadata = matter(content).data as Record<string, unknown>;
    });

    it('has all required frontmatter keys present', () => {
      for (const key of REQUIRED_METADATA_KEYS) {
        expect(metadata[key], `${relPath} missing frontmatter key: ${key}`).toBeTruthy();
      }
    });

    it('has valid field constraints', () => {
      expect(String(metadata.spec_version), `${relPath} invalid spec_version`).toBe('1.0');
      expect(['runtime', 'actions', 'context'], `${relPath} invalid integration_type`).toContain(metadata.integration_type);
      expect(['low', 'medium', 'high'], `${relPath} invalid risk_level`).toContain(metadata.risk_level);
    });

    it('has each required heading exactly once', () => {
      for (const heading of REQUIRED_HEADINGS) {
        expect(countHeadings(tree, heading), `${relPath} heading count for "${heading}"`).toBe(1);
      }
    });

    it('plan_id matches filename', () => {
      const isTemplate = relPath === 'templates/recipes/integration.discoclaw-recipe.md';
      if (!isTemplate) {
        const expectedPlanId = path.basename(filePath, '.discoclaw-recipe.md');
        expect(metadata.plan_id, `${relPath} plan_id should match filename`).toBe(expectedPlanId);
      }
    });

    it('satisfies risk-gated contract rules', () => {
      const integrationSection = getSectionContent(content, tree, '## Integration Contract');
      const acceptanceSection = getSectionContent(content, tree, '## Acceptance Tests');

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
        expect(hasIntegrationJson, `${relPath} medium/high plan missing integration JSON`).toBe(true);
        expect(hasAcceptanceJson, `${relPath} medium/high plan missing acceptance JSON`).toBe(true);
      }
    });
  });
});
