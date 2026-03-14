import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_TOOL_EXEC_CONTRACT,
  type OpenAIToolExecContractId,
} from '../runtime/openai-tool-exec.js';
import { CODEX_RUNTIME_CAPABILITIES } from '../runtime/tool-capabilities.js';
import type { RuntimeCapability } from '../runtime/types.js';
import {
  TRACKED_TOOLS_DIR,
  TRACKED_TOOLS_FILE_NAME,
  TRACKED_TOOLS_SECTION_LABEL,
  _resetTrackedToolsCacheForTests,
  buildPromptSafeTrackedToolsContent,
  collectAdvertisedTrackedToolContracts,
  collectAdvertisedTrackedToolGuarantees,
  loadTrackedToolsPreamble,
  renderTrackedToolsSection,
  resolveTrackedToolsPath,
} from './tracked-tools.js';

describe('resolveTrackedToolsPath', () => {
  it('resolves to templates/instructions/TOOLS.md by default', async () => {
    const resolved = resolveTrackedToolsPath();
    expect(resolved.endsWith(path.join('templates', TRACKED_TOOLS_DIR, TRACKED_TOOLS_FILE_NAME))).toBe(true);
    await expect(fs.access(resolved)).resolves.toBeUndefined();
  });

  it('resolves relative to a provided base directory', () => {
    const resolved = resolveTrackedToolsPath('/tmp/repo/src/instructions');
    expect(resolved).toBe(path.resolve('/tmp/repo/templates/instructions/TOOLS.md'));
  });
});

describe('renderTrackedToolsSection', () => {
  it('renders the canonical section header and trims trailing whitespace only', () => {
    const content = '# Header\n\nTool one\nTool two\n\n';
    const rendered = renderTrackedToolsSection(content);
    expect(rendered).toBe(`--- ${TRACKED_TOOLS_SECTION_LABEL} ---\n# Header\n\nTool one\nTool two`);
  });

  it('is deterministic for identical input', () => {
    const input = 'line 1\nline 2\n';
    expect(renderTrackedToolsSection(input)).toBe(renderTrackedToolsSection(input));
  });

  it('returns empty string for blank content', () => {
    expect(renderTrackedToolsSection('\n   \n')).toBe('');
  });
});

describe('buildPromptSafeTrackedToolsContent', () => {
  it('drops unsupported static tool-restriction sections from the tracked template', async () => {
    const trackedToolsContent = await fs.readFile(resolveTrackedToolsPath(), 'utf-8');
    const sanitized = buildPromptSafeTrackedToolsContent(trackedToolsContent);

    expect(sanitized).toContain('## Runtime Instruction Precedence');
    expect(sanitized).not.toContain('## Browser Automation (agent-browser)');
    expect(sanitized).not.toContain('## Service Operations (discoclaw)');
    expect(sanitized).toContain('## Webhook Server');
    expect(sanitized).toContain('Dispatches through the same cron execution pipeline as automations.');
    expect(sanitized).not.toContain('webhook jobs run without Discord action permissions or tool access');
  });
});

const COVERED_TRACKED_TOOL_RUNTIME_CONFIGS = [
  {
    name: 'default conservative preamble',
    runtimeContext: undefined,
    expectedContracts: [],
  },
  {
    name: 'codex grounded cli capabilities',
    runtimeContext: {
      runtimeId: 'codex' as const,
      runtimeCapabilities: new Set(CODEX_RUNTIME_CAPABILITIES),
    },
    expectedContracts: [],
  },
  {
    name: 'openai fs+exec runtime',
    runtimeContext: {
      runtimeId: 'openai' as const,
      runtimeCapabilities: new Set<RuntimeCapability>(['streaming_text', 'tools_fs', 'tools_exec']),
      runtimeTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    },
    expectedContracts: [
      'invocation_allowlist',
      'file_root_containment',
      'list_files_pattern_scope',
      'search_content_glob_scope',
      'bash_timeout_bound',
    ],
  },
  {
    name: 'openai hybrid runtime enabled',
    runtimeContext: {
      runtimeId: 'openai' as const,
      runtimeCapabilities: new Set<RuntimeCapability>(['streaming_text', 'tools_fs', 'tools_exec']),
      runtimeTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Pipeline', 'Step'],
      enableHybridPipeline: true,
    },
    expectedContracts: [
      'invocation_allowlist',
      'file_root_containment',
      'list_files_pattern_scope',
      'search_content_glob_scope',
      'bash_timeout_bound',
      'hybrid_pipeline_availability',
    ],
  },
  {
    name: 'openai hybrid runtime disabled',
    runtimeContext: {
      runtimeId: 'openai' as const,
      runtimeCapabilities: new Set<RuntimeCapability>(['streaming_text', 'tools_fs', 'tools_exec']),
      runtimeTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Pipeline', 'Step'],
      enableHybridPipeline: false,
    },
    expectedContracts: [
      'invocation_allowlist',
      'file_root_containment',
      'list_files_pattern_scope',
      'search_content_glob_scope',
      'bash_timeout_bound',
    ],
  },
] satisfies Array<{
  name: string;
  runtimeContext:
    | {
      runtimeId: 'codex' | 'openai';
      runtimeCapabilities: ReadonlySet<RuntimeCapability>;
      runtimeTools?: string[];
      enableHybridPipeline?: boolean;
    }
    | undefined;
  expectedContracts: OpenAIToolExecContractId[];
}>;

describe('collectAdvertisedTrackedToolContracts', () => {
  it.each(COVERED_TRACKED_TOOL_RUNTIME_CONFIGS)(
    'matches the audited enforcement-backed contract for $name',
    ({ runtimeContext, expectedContracts }) => {
      const contracts = collectAdvertisedTrackedToolContracts(runtimeContext);
      const guarantees = collectAdvertisedTrackedToolGuarantees(runtimeContext);

      expect(contracts).toEqual(expectedContracts);
      expect(guarantees).toEqual(
        expectedContracts.map((contractId) => OPENAI_TOOL_EXEC_CONTRACT[contractId].runtimeWording),
      );

      for (const contractId of contracts) {
        expect(OPENAI_TOOL_EXEC_CONTRACT[contractId].enforcementGate.length).toBeGreaterThan(0);
      }
    },
  );
});

describe('loadTrackedToolsPreamble', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    _resetTrackedToolsCacheForTests();
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns an explicit warning section and logs when the tracked tools file is missing', () => {
    const missingPath = path.join(os.tmpdir(), `missing-${Date.now()}-TOOLS.md`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTrackedToolsPreamble({ trackedToolsPath: missingPath, forceReload: true });
    expect(result).toContain(`--- ${TRACKED_TOOLS_SECTION_LABEL} ---`);
    expect(result).toContain('[tracked tools unavailable: failed to read');
    expect(result).toContain(missingPath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`instructions:tracked-tools failed to read ${missingPath}`),
    );
    warnSpy.mockRestore();
  });

  it('returns only the tracked tools section', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-tools-'));
    dirs.push(dir);
    const trackedToolsPath = path.join(dir, 'TOOLS.md');

    await fs.writeFile(trackedToolsPath, '# Tools\nUse browser automation wisely\n', 'utf-8');

    const preamble = loadTrackedToolsPreamble({
      trackedToolsPath,
      forceReload: true,
    });

    expect(preamble.startsWith(`--- ${TRACKED_TOOLS_SECTION_LABEL} ---`)).toBe(true);
    expect(preamble).toContain('# Tools\nUse browser automation wisely');
  });

  it('sanitizes the default tracked template before rendering it into the preamble', () => {
    const preamble = loadTrackedToolsPreamble({
      trackedToolsPath: resolveTrackedToolsPath(),
      forceReload: true,
    });

    expect(preamble).toContain(`--- ${TRACKED_TOOLS_SECTION_LABEL} ---`);
    expect(preamble).not.toContain('## Browser Automation (agent-browser)');
    expect(preamble).not.toContain('## Service Operations (discoclaw)');
    expect(preamble).not.toContain('webhook jobs run without Discord action permissions or tool access');
  });

  it('re-renders cached tracked tools content for runtime-specific audited guarantees', () => {
    const trackedToolsPath = resolveTrackedToolsPath();
    const first = loadTrackedToolsPreamble({
      trackedToolsPath,
      forceReload: true,
    });
    const second = loadTrackedToolsPreamble({
      trackedToolsPath,
      runtimeId: 'openai',
      runtimeCapabilities: new Set<RuntimeCapability>(['streaming_text', 'tools_fs', 'tools_exec']),
      runtimeTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    });

    expect(first).not.toContain('## Audited Runtime Tool Guarantees');
    expect(second).toContain('## Audited Runtime Tool Guarantees');
    expect(second).toContain(OPENAI_TOOL_EXEC_CONTRACT.bash_timeout_bound.runtimeWording);
    expect(second).not.toContain('## Browser Automation (agent-browser)');
  });

  it('caches by path and only reloads when forced', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-tools-'));
    dirs.push(dir);
    const trackedToolsPath = path.join(dir, 'TOOLS.md');

    await fs.writeFile(trackedToolsPath, 'first version\n', 'utf-8');
    const first = loadTrackedToolsPreamble({ trackedToolsPath, forceReload: true });
    expect(first).toContain('first version');

    await fs.writeFile(trackedToolsPath, 'second version\n', 'utf-8');
    const cached = loadTrackedToolsPreamble({ trackedToolsPath });
    expect(cached).toBe(first);
    expect(cached).not.toContain('second version');

    const reloaded = loadTrackedToolsPreamble({ trackedToolsPath, forceReload: true });
    expect(reloaded).toContain('second version');
    expect(reloaded).not.toBe(first);
  });

  it('invalidates cache when path changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracked-tools-'));
    dirs.push(dir);
    const aPath = path.join(dir, 'a.md');
    const bPath = path.join(dir, 'b.md');
    await fs.writeFile(aPath, 'A', 'utf-8');
    await fs.writeFile(bPath, 'B', 'utf-8');

    const a = loadTrackedToolsPreamble({ trackedToolsPath: aPath, forceReload: true });
    const b = loadTrackedToolsPreamble({ trackedToolsPath: bPath });
    expect(a).toContain('A');
    expect(b).toContain('B');
  });
});
