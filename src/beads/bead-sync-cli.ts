export {
  parseArgInt,
  runSyncWithStore,
  runTaskSyncCliMain,
  runTaskSyncWithStore,
} from '../tasks/task-sync-cli.js';

export type {
  RunSyncWithStoreOpts,
  RunTaskSyncWithStoreOpts,
} from '../tasks/task-sync-cli.js';

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  const { runTaskSyncCliMain } = await import('../tasks/task-sync-cli.js');
  await runTaskSyncCliMain();
}
