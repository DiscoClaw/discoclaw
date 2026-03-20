import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const esmEntry = path.join(__dirname, 'index.mjs');
const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(projectRoot, 'dist', 'vendor');
const outfile = path.join(outDir, 'canvas-runtime.js');

try {
  await build({
    entryPoints: [esmEntry],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    minify: true,
    sourcemap: false,
  });
  process.stdout.write(`Bundled canvas-runtime → ${outfile}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`esbuild failed: ${message}\n`);
  process.exit(1);
}
