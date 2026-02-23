import type { RuntimeRegistry } from './runtime/registry.js';
import type { RuntimeAdapter } from './runtime/types.js';

type RuntimeLog = {
  info(payload: unknown, msg?: string): void;
  warn(payload: unknown, msg?: string): void;
};

type RuntimeDebugOptions = {
  enabled: boolean;
  log: RuntimeLog;
  env: NodeJS.ProcessEnv;
  claude: {
    bin: string;
    outputFormat: string;
    echoStdio: boolean;
    verbose: boolean;
    dangerouslySkipPermissions: boolean;
  };
  runtime: {
    selected: string;
    runtimeId: string;
    model: string;
    toolsCount: number;
    timeoutMs: number;
    workspaceCwd: string;
    groupsDir: string;
    useRuntimeSessions: boolean;
    maxConcurrentInvocations: number;
  };
};

type ResolveForgeRuntimesOptions = {
  primaryRuntimeName: string;
  primaryRuntime: RuntimeAdapter;
  forgeDrafterRuntime?: string;
  forgeAuditorRuntime?: string;
  runtimeRegistry: RuntimeRegistry;
  log: RuntimeLog;
};

function resolveOptionalForgeRuntime(
  runtimeName: string,
  opts: ResolveForgeRuntimesOptions,
  fieldLabel: 'FORGE_DRAFTER_RUNTIME' | 'FORGE_AUDITOR_RUNTIME',
): RuntimeAdapter | undefined {
  if (runtimeName === opts.primaryRuntimeName) return opts.primaryRuntime;
  const resolved = opts.runtimeRegistry.get(runtimeName);
  if (resolved) return resolved;
  opts.log.warn(
    {
      field: fieldLabel,
      configuredRuntime: runtimeName,
      availableRuntimes: opts.runtimeRegistry.list(),
      fallbackRuntime: opts.primaryRuntimeName,
    },
    `${fieldLabel} is not registered; falling back to PRIMARY_RUNTIME`,
  );
  return undefined;
}

export function logRuntimeDebugConfig(opts: RuntimeDebugOptions): void {
  if (!opts.enabled) return;
  opts.log.info(
    {
      env: {
        HOME: opts.env.HOME,
        USER: opts.env.USER,
        PATH: opts.env.PATH,
        XDG_RUNTIME_DIR: opts.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: opts.env.DBUS_SESSION_BUS_ADDRESS ? '(set)' : '(unset)',
        DISPLAY: opts.env.DISPLAY ? '(set)' : '(unset)',
        WAYLAND_DISPLAY: opts.env.WAYLAND_DISPLAY ? '(set)' : '(unset)',
      },
      claude: opts.claude,
      runtime: opts.runtime,
    },
    'debug:runtime config',
  );
}

export function resolveForgeRuntimes(opts: ResolveForgeRuntimesOptions): {
  drafterRuntime: RuntimeAdapter | undefined;
  auditorRuntime: RuntimeAdapter | undefined;
} {
  const drafterRuntime = opts.forgeDrafterRuntime
    ? resolveOptionalForgeRuntime(opts.forgeDrafterRuntime, opts, 'FORGE_DRAFTER_RUNTIME')
    : undefined;
  const auditorRuntime = opts.forgeAuditorRuntime
    ? resolveOptionalForgeRuntime(opts.forgeAuditorRuntime, opts, 'FORGE_AUDITOR_RUNTIME')
    : undefined;
  return { drafterRuntime, auditorRuntime };
}

export function collectActiveProviders(opts: {
  primaryRuntimeId: string;
  forgeCommandsEnabled: boolean;
  drafterRuntime: RuntimeAdapter | undefined;
  auditorRuntime: RuntimeAdapter | undefined;
}): Set<string> {
  const activeProviders = new Set<string>([opts.primaryRuntimeId]);
  if (!opts.forgeCommandsEnabled) return activeProviders;
  if (opts.drafterRuntime?.id) activeProviders.add(opts.drafterRuntime.id);
  if (opts.auditorRuntime?.id) activeProviders.add(opts.auditorRuntime.id);
  return activeProviders;
}
