const DIST_SERVER_URL = new URL('../dist/dashboard/server.js', import.meta.url);

let dashboardServerModulePromise;

async function loadDashboardServerModule() {
  if (!dashboardServerModulePromise) {
    dashboardServerModulePromise = import(DIST_SERVER_URL.href).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('dashboard/server.js requires a built dist tree. Run `pnpm build` first.');
      }
      throw error;
    });
  }

  return dashboardServerModulePromise;
}

export async function startDashboardServer(options = {}) {
  const serverModule = await loadDashboardServerModule();
  return serverModule.startDashboardServer(options);
}
