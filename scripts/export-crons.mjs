/**
 * One-off script: export all cron jobs from the local stats store to a JSON file.
 * The stats store is the canonical source of truth — no Discord connection required.
 *
 * Usage: node scripts/export-crons.mjs [output-file]
 *   e.g. node scripts/export-crons.mjs cron-export.json
 *        node scripts/export-crons.mjs           # defaults to cron-export.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outputFile = process.argv[2] || 'cron-export.json';

const dataDir = process.env.DISCOCLAW_DATA_DIR;
const statsPath = process.env.DISCOCLAW_CRON_STATS_DIR
  ? path.join(process.env.DISCOCLAW_CRON_STATS_DIR, 'cron-run-stats.json')
  : dataDir
    ? path.join(dataDir, 'cron', 'cron-run-stats.json')
    : path.join(__dirname, '..', 'data', 'cron', 'cron-run-stats.json');

let raw;
try {
  raw = await fs.readFile(statsPath, 'utf8');
} catch (err) {
  console.error(`Could not read stats file at ${statsPath}: ${err.message}`);
  process.exit(1);
}

const store = JSON.parse(raw);
const jobs = store.jobs ?? {};

const exported = Object.values(jobs).map((record) => ({
  cronId: record.cronId,
  name: record.prompt?.slice(0, 60).replace(/\n/g, ' ').trim() || record.cronId,
  threadId: record.threadId,
  triggerType: record.triggerType ?? 'schedule',
  schedule: record.schedule ?? null,
  timezone: record.timezone ?? null,
  channel: record.channel ?? null,
  prompt: record.prompt ?? null,
  disabled: record.disabled,
  cadence: record.cadence ?? null,
  silent: record.silent ?? false,
  routingMode: record.routingMode ?? 'default',
  allowedActions: record.allowedActions ?? null,
  chain: record.chain ?? null,
  runCount: record.runCount,
  lastRunAt: record.lastRunAt ?? null,
  lastRunStatus: record.lastRunStatus ?? null,
}));

const output = JSON.stringify(exported, null, 2);
await fs.writeFile(outputFile, output, 'utf8');

console.log(`Exported ${exported.length} cron job(s) to ${outputFile}`);
for (const job of exported) {
  const status = job.disabled ? 'paused' : 'active';
  const trigger = job.schedule ? `${job.schedule} (${job.timezone ?? 'UTC'})` : job.triggerType;
  console.log(`  [${status}] ${job.cronId}  ${trigger}  → #${job.channel ?? '?'}`);
}
