import { build } from 'esbuild';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use the local ESM entry which re-exports @discord/embedded-app-sdk.
// esbuild resolves the bare specifier via node_modules and bundles
// everything into a single self-contained file — no chained sub-imports.
const esmEntry = path.join(__dirname, 'index.mjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(projectRoot, 'dist', 'vendor');
const outfile = path.join(outDir, 'embedded-app-sdk.js');

try {
  await build({
    entryPoints: [esmEntry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: false,
    sourcemap: false,
  });
  process.stdout.write(`Bundled embedded-app-sdk → ${outfile}\n`);
} catch (err) {
  process.stderr.write(`esbuild failed: ${err.message}\n`);
  process.exit(1);
}
