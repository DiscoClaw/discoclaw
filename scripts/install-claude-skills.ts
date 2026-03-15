import fs from 'node:fs/promises';
import path from 'node:path';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const srcSkillsDir = path.join(repoRoot, 'skills');
  const dstSkillsDir = path.join(repoRoot, '.claude', 'skills');

  if (!await pathExists(srcSkillsDir)) {
    throw new Error(`Missing skills dir: ${srcSkillsDir}`);
  }

  await fs.mkdir(dstSkillsDir, { recursive: true });

  const entries = await fs.readdir(srcSkillsDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Remove stale symlinks in .claude/skills/ that no longer match a skills/ entry
  let pruned = 0;
  const existingDst = await fs.readdir(dstSkillsDir, { withFileTypes: true });
  for (const entry of existingDst) {
    if (entry.name === 'README.md') continue;
    const dstPath = path.join(dstSkillsDir, entry.name);
    if (!skillDirs.includes(entry.name)) {
      await fs.rm(dstPath, { recursive: true, force: true });
      pruned++;
    }
  }

  let linked = 0;
  let skipped = 0;

  for (const name of skillDirs) {
    const src = path.join(srcSkillsDir, name);
    const srcSkillMd = path.join(src, 'SKILL.md');
    if (!await pathExists(srcSkillMd)) {
      skipped++;
      continue;
    }

    const dst = path.join(dstSkillsDir, name);
    // Make dst a symlink to the repo skill folder so updates are immediate.
    // Relative from .claude/skills/<name> to skills/<name> is ../../skills/<name>.
    const relTarget = path.join('..', '..', 'skills', name);

    // Remove existing dst (file/dir/symlink) first for idempotence.
    if (await pathExists(dst)) {
      await fs.rm(dst, { recursive: true, force: true });
    }

    await fs.symlink(relTarget, dst, 'dir');
    linked++;
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        srcSkillsDir,
        dstSkillsDir,
        linked,
        skipped,
        pruned,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();

