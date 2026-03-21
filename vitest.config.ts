import { configDefaults, defineConfig } from 'vitest/config';

const isCi = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
const maxForks = isCi ? 2 : 4;

export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    // Keep tests independent of local-only symlinks (legacy workspace, content/workspace exports, etc).
    // Vitest can hit ELOOP when scanning symlinked trees.
    exclude: [
      ...configDefaults.exclude,
      'legacy/**',
      'workspace/**',
      'exports/**',
      'content/**',
      'var/**',
    ],
    clearMocks: true,
    unstubEnvs: true,
    // Cap parallelism to prevent OOM. Local/dev runs tolerate 4 forks, but
    // GitHub runners are tighter and have shown exit-137 kills unless we drop lower.
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks,
      },
    },
  },
});
