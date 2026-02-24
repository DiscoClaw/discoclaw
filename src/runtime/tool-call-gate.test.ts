import { describe, expect, it } from 'vitest';
import { DESTRUCTIVE_TOOL_PATTERNS, matchesDestructivePattern } from './tool-call-gate.js';
import type { EngineEvent } from './types.js';

describe('DESTRUCTIVE_TOOL_PATTERNS', () => {
  it('exports a non-empty pattern list', () => {
    expect(DESTRUCTIVE_TOOL_PATTERNS.length).toBeGreaterThan(0);
  });

  it('every entry has required fields', () => {
    for (const entry of DESTRUCTIVE_TOOL_PATTERNS) {
      expect(typeof entry.tool).toBe('string');
      expect(typeof entry.field).toBe('string');
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.reason).toBe('string');
    }
  });
});

describe('matchesDestructivePattern - dangerous Bash commands', () => {
  it('matches rm -rf targeting a non-artifact path', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf /home/user/important' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('rm -rf');
  });

  it('matches rm -rf with flags in reverse order (-fr)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -fr /etc/config' });
    expect(result.matched).toBe(true);
  });

  it('matches rm -rf with uppercase flags (-Rf)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -Rf /tmp/important' });
    expect(result.matched).toBe(true);
  });

  it('matches git push --force', () => {
    const result = matchesDestructivePattern('Bash', { command: 'git push origin main --force' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('git push --force');
  });

  it('matches git push -f', () => {
    const result = matchesDestructivePattern('Bash', { command: 'git push -f origin main' });
    expect(result.matched).toBe(true);
  });

  it('matches git branch -D', () => {
    const result = matchesDestructivePattern('Bash', { command: 'git branch -D feature/my-branch' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('git branch -D');
  });

  it('matches DROP TABLE (uppercase)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'mysql -e "DROP TABLE users"' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('DROP TABLE');
  });

  it('matches DROP TABLE (lowercase — case variation)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'drop table users' });
    expect(result.matched).toBe(true);
  });

  it('matches DROP TABLE (mixed case — case variation)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'Drop Table accounts' });
    expect(result.matched).toBe(true);
  });

  it('matches chmod 777', () => {
    const result = matchesDestructivePattern('Bash', { command: 'chmod 777 /etc/passwd' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('chmod 777');
  });

  it('matches chmod 0777', () => {
    const result = matchesDestructivePattern('Bash', { command: 'chmod 0777 script.sh' });
    expect(result.matched).toBe(true);
  });
});

describe('matchesDestructivePattern - safe Bash commands', () => {
  it('does not match rm -rf targeting dist/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf dist/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting ./dist/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf ./dist/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting node_modules', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf node_modules' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting build/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf ./build/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting .cache/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf .cache/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting .next/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf .next/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting coverage/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf coverage/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting tmp/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf tmp/' });
    expect(result.matched).toBe(false);
  });

  it('does not match rm -rf targeting out/', () => {
    const result = matchesDestructivePattern('Bash', { command: 'rm -rf out/' });
    expect(result.matched).toBe(false);
  });

  it('does not match safe git push (no force flag)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'git push origin main' });
    expect(result.matched).toBe(false);
  });

  it('does not match git branch -d (lowercase, safe delete)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'git branch -d feature/done' });
    expect(result.matched).toBe(false);
  });

  it('does not match git branch --delete (long safe form)', () => {
    const result = matchesDestructivePattern('Bash', { command: 'git branch --delete old-branch' });
    expect(result.matched).toBe(false);
  });

  it('does not match SELECT statement', () => {
    const result = matchesDestructivePattern('Bash', { command: 'mysql -e "SELECT * FROM users"' });
    expect(result.matched).toBe(false);
  });

  it('does not match chmod 755', () => {
    const result = matchesDestructivePattern('Bash', { command: 'chmod 755 script.sh' });
    expect(result.matched).toBe(false);
  });

  it('does not match chmod 644', () => {
    const result = matchesDestructivePattern('Bash', { command: 'chmod 644 file.txt' });
    expect(result.matched).toBe(false);
  });
});

describe('matchesDestructivePattern - sensitive Write paths', () => {
  it('matches bare .env file', () => {
    const result = matchesDestructivePattern('Write', { file_path: '.env' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('.env');
  });

  it('matches .env.local', () => {
    const result = matchesDestructivePattern('Write', { file_path: '.env.local' });
    expect(result.matched).toBe(true);
  });

  it('matches .env.production in a nested path', () => {
    const result = matchesDestructivePattern('Write', { file_path: '/project/.env.production' });
    expect(result.matched).toBe(true);
  });

  it('matches root-policy.ts', () => {
    const result = matchesDestructivePattern('Write', { file_path: '/project/src/root-policy.ts' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('root-policy.ts');
  });

  it('matches ~/.ssh/authorized_keys', () => {
    const result = matchesDestructivePattern('Write', { file_path: '~/.ssh/authorized_keys' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('.ssh');
  });

  it('matches an absolute .ssh path', () => {
    const result = matchesDestructivePattern('Write', { file_path: '/home/user/.ssh/id_rsa' });
    expect(result.matched).toBe(true);
  });

  it('matches ~/.claude/settings.json', () => {
    const result = matchesDestructivePattern('Write', { file_path: '~/.claude/settings.json' });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain('.claude');
  });
});

describe('matchesDestructivePattern - sensitive Edit paths', () => {
  it('matches Edit tool for .env file', () => {
    const result = matchesDestructivePattern('Edit', { file_path: '/project/.env' });
    expect(result.matched).toBe(true);
  });

  it('matches Edit tool for root-policy.ts', () => {
    const result = matchesDestructivePattern('Edit', { file_path: '/project/root-policy.ts' });
    expect(result.matched).toBe(true);
  });

  it('matches Edit tool for ~/.ssh/ path', () => {
    const result = matchesDestructivePattern('Edit', { file_path: '~/.ssh/config' });
    expect(result.matched).toBe(true);
  });

  it('matches Edit tool for ~/.claude/ path', () => {
    const result = matchesDestructivePattern('Edit', { file_path: '~/.claude/CLAUDE.md' });
    expect(result.matched).toBe(true);
  });
});

describe('matchesDestructivePattern - normal file edits pass', () => {
  it('allows a normal .ts source file via Edit', () => {
    const result = matchesDestructivePattern('Edit', { file_path: '/project/src/index.ts' });
    expect(result.matched).toBe(false);
  });

  it('allows a normal .js file via Write', () => {
    const result = matchesDestructivePattern('Write', { file_path: '/project/src/utils.js' });
    expect(result.matched).toBe(false);
  });

  it('allows a file with "env" in its name (not a .env file)', () => {
    const result = matchesDestructivePattern('Write', { file_path: '/project/src/environment.ts' });
    expect(result.matched).toBe(false);
  });

  it('allows the dotenv npm package path', () => {
    const result = matchesDestructivePattern('Write', {
      file_path: '/project/node_modules/dotenv/lib/main.js',
    });
    expect(result.matched).toBe(false);
  });

  it('allows a root-policy-like name that is not exactly root-policy.ts', () => {
    const result = matchesDestructivePattern('Write', { file_path: '/project/root-policy.ts.bak' });
    expect(result.matched).toBe(false);
  });
});

describe('matchesDestructivePattern - edge cases', () => {
  it('returns not matched for an empty input object', () => {
    const result = matchesDestructivePattern('Bash', {});
    expect(result.matched).toBe(false);
    expect(result.reason).toBe('');
  });

  it('returns not matched for null input', () => {
    const result = matchesDestructivePattern('Bash', null);
    expect(result.matched).toBe(false);
  });

  it('returns not matched for undefined input', () => {
    const result = matchesDestructivePattern('Bash', undefined);
    expect(result.matched).toBe(false);
  });

  it('returns not matched for a primitive input', () => {
    const result = matchesDestructivePattern('Bash', 'rm -rf /important');
    expect(result.matched).toBe(false);
  });

  it('returns not matched for an unknown tool name', () => {
    const result = matchesDestructivePattern('UnknownTool', { command: 'rm -rf /important' });
    expect(result.matched).toBe(false);
  });

  it('returns not matched for lowercase bash tool name (case variation)', () => {
    const result = matchesDestructivePattern('bash', { command: 'rm -rf /important' });
    expect(result.matched).toBe(false);
  });

  it('returns not matched for uppercase BASH tool name (case variation)', () => {
    const result = matchesDestructivePattern('BASH', { command: 'rm -rf /important' });
    expect(result.matched).toBe(false);
  });

  it('handles a non-string command field gracefully', () => {
    const result = matchesDestructivePattern('Bash', { command: 42 });
    expect(result.matched).toBe(false);
  });

  it('handles a missing file_path field gracefully', () => {
    const result = matchesDestructivePattern('Write', { content: 'some content' });
    expect(result.matched).toBe(false);
  });
});

describe('matchesDestructivePattern - text-mode no-op', () => {
  it('gate flag remains unset when no tool_start events are emitted', () => {
    // Simulates what an orchestration loop would do when processing a plain
    // text-mode stream: inspect every tool_start event, flag if destructive.
    // When there are no tool_start events the flag must stay false and no
    // error must be thrown.
    let halted = false;

    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_final', text: 'Hello world' },
      { type: 'done' },
    ];

    for (const event of events) {
      if (event.type === 'tool_start') {
        const result = matchesDestructivePattern(event.name, event.input);
        if (result.matched) halted = true;
      }
    }

    expect(halted).toBe(false);
  });

  it('gate flag is set when a destructive tool_start event appears', () => {
    let halted = false;

    const events: EngineEvent[] = [
      { type: 'text_delta', text: 'Cleaning up...' },
      { type: 'tool_start', name: 'Bash', input: { command: 'rm -rf /important' } },
      { type: 'tool_end', name: 'Bash', ok: true },
      { type: 'done' },
    ];

    for (const event of events) {
      if (event.type === 'tool_start') {
        const result = matchesDestructivePattern(event.name, event.input);
        if (result.matched) halted = true;
      }
    }

    expect(halted).toBe(true);
  });
});
