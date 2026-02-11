import { Cron } from 'croner';
import type { CadenceTag } from './run-stats.js';

/**
 * Detect the cadence of a cron schedule expression.
 *
 * Uses the same 5-field format that croner accepts. Validates the schedule
 * parses via croner before classifying — if it throws, returns 'daily' as fallback.
 *
 * Logic:
 * - minute is * or *\/N → frequent (runs multiple times per hour)
 * - minute specific + hour * → hourly
 * - minute+hour specific, dom+dow * → daily
 * - dow not * → weekly
 * - dom not * → monthly
 * - fallback: daily
 */
export function detectCadence(schedule: string): CadenceTag {
  // Validate the schedule parses.
  try {
    new Cron(schedule).stop();
  } catch {
    return 'daily';
  }

  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return 'daily';

  const [minute, hour, dom, , dow] = parts;

  const isWild = (f: string) => f === '*';
  const isStep = (f: string) => /^\*\/\d+$/.test(f);

  // Minute is wildcard or step → runs multiple times per hour → frequent.
  if (isWild(minute) || isStep(minute)) return 'frequent';

  // Minute specific, hour is wildcard or step → runs every hour.
  if (isWild(hour) || isStep(hour)) return 'hourly';

  // Minute + hour specific, check day fields.
  if (!isWild(dow)) return 'weekly';
  if (!isWild(dom)) return 'monthly';

  return 'daily';
}
