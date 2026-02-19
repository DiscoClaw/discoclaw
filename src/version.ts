import { execa } from 'execa';

/**
 * Returns the short git commit hash of the current HEAD, or null if git is
 * unavailable or the working directory is not a git repository.
 */
export async function getGitHash(): Promise<string | null> {
  try {
    const result = await execa('git', ['rev-parse', '--short', 'HEAD']);
    const hash = result.stdout.trim();
    return hash || null;
  } catch {
    return null;
  }
}
