import { Cron } from 'croner';
import type { CadenceTag } from './run-stats.js';

/**
 * Count distinct values in a cron field like "1", "1,7", "3-6", "1-3,7".
 * Returns Infinity for wildcards/steps (unbounded).
 */
function countFieldValues(field: string): number {
  if (field === '*' || /^\*\/\d+$/.test(field)) return Infinity;

  let count = 0;
  for (const part of field.split(',')) {
    const range = part.split('-');
    if (range.length === 2) {
      const lo = parseInt(range[0], 10);
      const hi = parseInt(range[1], 10);
      if (!isNaN(lo) && !isNaN(hi) && hi >= lo) {
        count += hi - lo + 1;
      } else {
        count += 1;
      }
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Detect the cadence of a cron schedule expression.
 *
 * Uses the same 5-field format that croner accepts. Validates the schedule
 * parses via croner before classifying — if it throws, returns 'daily' as fallback.
 *
 * Logic:
 * - single specific month (e.g., "2") → yearly
 * - multi-month (e.g., "1,7" or "3-6") → fall through to normal classification
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

  const [minute, hour, dom, month, dow] = parts;

  const isWild = (f: string) => f === '*';
  const isStep = (f: string) => /^\*\/\d+$/.test(f);

  // Single specific month → fires once a year (annual schedule).
  // Multi-month patterns (e.g., "1,7" or "3-6") fall through to normal classification.
  if (!isWild(month) && !isStep(month) && countFieldValues(month) === 1) return 'yearly';

  // Minute is wildcard or step → runs multiple times per hour → frequent.
  if (isWild(minute) || isStep(minute)) return 'frequent';

  // Minute specific, hour is wildcard or step → runs every hour.
  if (isWild(hour) || isStep(hour)) return 'hourly';

  // Minute + hour specific, check day fields.
  if (!isWild(dow)) return 'weekly';
  if (!isWild(dom)) return 'monthly';

  return 'daily';
}
