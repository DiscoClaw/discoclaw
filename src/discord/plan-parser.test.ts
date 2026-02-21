import { describe, expect, it } from 'vitest';
import { getLatestAuditVerdictFromSection, getSection, parsePlan } from './plan-parser.js';

describe('plan-parser', () => {
  it('parses title, metadata, and top-level sections', () => {
    const content = `# Plan: Parser test

**ID:** plan-123
**Task:** ws-123
**Status:** APPROVED

## Objective

Ship parser.
`;
    const parsed = parsePlan(content);
    expect(parsed.title).toBe('Parser test');
    expect(parsed.metadata.get('ID')).toBe('plan-123');
    expect(parsed.metadata.get('Task')).toBe('ws-123');
    expect(getSection(parsed, 'Objective')).toBe('Ship parser.');
  });

  it('ignores headings inside fenced code blocks', () => {
    const content = `# Plan: Fence test

**ID:** plan-001

## Objective

\`\`\`md
## Not a section
\`\`\`

Real objective.

## Audit Log

none`;
    const parsed = parsePlan(content);
    expect(getSection(parsed, 'Objective')).toContain('Real objective.');
    expect(getSection(parsed, 'Not a section')).toBe('');
  });

  it('extracts latest verdict from modern verdict lines', () => {
    const verdict = getLatestAuditVerdictFromSection(`
### Review 1
**Verdict:** Needs revision.

### Review 2
**Verdict:** Ready to approve.
`);
    expect(verdict).toBe('Ready to approve.');
  });

  it('extracts latest verdict from legacy heading format', () => {
    const verdict = getLatestAuditVerdictFromSection(`
### Review 1
#### Verdict
Needs revision.

### Review 2
#### Verdict
Ready to approve.
`);
    expect(verdict).toBe('Ready to approve.');
  });
});
