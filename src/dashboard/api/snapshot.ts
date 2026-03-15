import type { DashboardDeps, DashboardSnapshot } from '../../cli/dashboard.js';
import { collectDashboardSnapshot } from '../../cli/dashboard.js';
import type { InspectOptions } from '../../health/config-doctor.js';

export type DashboardSnapshotApiResponse = {
  ok: true;
  snapshot: DashboardSnapshot;
};

export async function buildSnapshotResponse(
  inspectOpts: Required<Pick<InspectOptions, 'cwd' | 'env'>>,
  deps: DashboardDeps,
): Promise<DashboardSnapshotApiResponse> {
  return {
    ok: true,
    snapshot: await collectDashboardSnapshot(inspectOpts, deps),
  };
}
