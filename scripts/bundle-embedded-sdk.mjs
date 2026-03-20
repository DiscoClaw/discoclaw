import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@discord/embedded-app-sdk');
// resolve to the ESM entry (output/index.mjs) beside the CJS one
const sdkDir = path.dirname(sdkEntry);
const esmEntry = path.join(sdkDir, 'index.mjs');

const outdir = path.resolve('dist', 'vendor');

await mkdir(outdir, { recursive: true });

try {
  await build({
    entryPoints: [esmEntry],
    outfile: path.join(outdir, 'embedded-app-sdk.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: false,
    sourcemap: false,
  });
  process.stdout.write(`Bundled embedded-app-sdk → ${outdir}/embedded-app-sdk.js\n`);
} catch (err) {
  process.stderr.write(`esbuild failed: ${err.message}\n`);
  process.exit(1);
}
