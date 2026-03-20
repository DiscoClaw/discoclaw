import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@discord/embedded-app-sdk');
// resolve to the ESM entry (output/index.mjs) beside the CJS one
const sdkDir = path.dirname(sdkEntry);
const esmEntry = path.join(sdkDir, 'index.mjs');

const outfile = path.join(__dirname, 'bundle.js');

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
