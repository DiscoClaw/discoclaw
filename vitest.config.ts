import { configDefaults, defineConfig } from 'vitest/config';

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
    // Cap parallelism to prevent OOM when tests run under discoclaw.service.
    // 11 uncapped workers hit ~44GB RAM. 4 workers keeps peak usage reasonable.
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});

