# Automated Section-by-Section Code Review

## What this does

`pnpm review:sections` runs a static review pass over tracked files, grouped into sections, and writes reports to `docs/code-review/`.

It flags risk signals (not guaranteed bugs), including:
- long production source files
- `any`-typed boundaries in production TypeScript
- empty `catch {}` blocks
- TODO/FIXME/HACK markers
- shell-enabled subprocess usage
- large source files without nearby tests

## Sections

- `discord`
- `tasks`
- `runtime-pipeline`
- `cron`
- `platform-adapters`
- `core-src`
- `automation-scripts`
- `ci-workflows`
- `docs`
- `root-config`
- `other-tracked`

## Commands

Run full review:

```bash
pnpm review:sections
```

Run one section:

```bash
pnpm review:sections --section discord
```

Run one section plus build/test/preflight gates:

```bash
pnpm review:sections --section discord --with-gates
```

Include test files in heuristic findings:

```bash
pnpm review:sections --section discord --include-tests
```

## Output

For each run, the script writes:
- Markdown report: `docs/code-review/section-review-YYYY-MM-DD[-section].md`
- JSON report: `docs/code-review/section-review-YYYY-MM-DD[-section].json`

## Suggested workflow

1. Run one section at a time with `--with-gates`.
2. Fix highest-severity findings in that section.
3. Re-run the same section until findings are acceptable.
4. Move to the next section.
