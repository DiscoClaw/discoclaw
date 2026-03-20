import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(projectRoot, 'dist', 'vendor');

async function bundleVendorScript({ bundleName, entryPoint, format, minify }) {
  const outfile = path.join(outDir, `${bundleName}.js`);

  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format,
    platform: 'browser',
    minify,
    sourcemap: false,
  });

  process.stdout.write(`Bundled ${bundleName} → ${outfile}\n`);
}

try {
  // Keep the Discord SDK bundle on the same vendor-bundle path shape that the
  // canvas runtime now uses, so the canvas server can preload both artifacts at
  // startup without special-casing build metadata.
  await bundleVendorScript({
    bundleName: 'embedded-app-sdk',
    // Use the local ESM entry which re-exports @discord/embedded-app-sdk.
    // esbuild resolves the bare specifier via node_modules and bundles
    // everything into a single self-contained file — no chained sub-imports.
    entryPoint: path.join(__dirname, 'index.mjs'),
    format: 'esm',
    minify: false,
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`esbuild failed: ${message}\n`);
  process.exit(1);
}
