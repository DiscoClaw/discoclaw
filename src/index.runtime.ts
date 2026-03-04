import type { RuntimeRegistry } from './runtime/registry.js';
import { withConcurrencyLimit, type ConcurrencyLimiter } from './runtime/concurrency-limit.js';
import { withGlobalSupervisor, type GlobalSupervisorLimits } from './runtime/global-supervisor.js';
import type { RuntimeAdapter } from './runtime/types.js';

type RuntimeLog = {
  debug?(payload: unknown, msg?: string): void;
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

type OptionalRuntimeFieldLabel =
  | 'FORGE_DRAFTER_RUNTIME'
  | 'FORGE_AUDITOR_RUNTIME'
  | 'DISCOCLAW_FAST_RUNTIME';

function resolveOptionalRuntime(
  runtimeName: string,
  opts: {
    primaryRuntimeName: string;
    primaryRuntime: RuntimeAdapter;
    runtimeRegistry: RuntimeRegistry;
    log: RuntimeLog;
  },
  fieldLabel: OptionalRuntimeFieldLabel,
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
    ? resolveOptionalRuntime(opts.forgeDrafterRuntime, opts, 'FORGE_DRAFTER_RUNTIME')
    : undefined;
  const auditorRuntime = opts.forgeAuditorRuntime
    ? resolveOptionalRuntime(opts.forgeAuditorRuntime, opts, 'FORGE_AUDITOR_RUNTIME')
    : undefined;
  return { drafterRuntime, auditorRuntime };
}

export function resolveFastRuntime(opts: {
  primaryRuntimeName: string;
  primaryRuntime: RuntimeAdapter;
  fastRuntime?: string;
  runtimeRegistry: RuntimeRegistry;
  log: RuntimeLog;
}): RuntimeAdapter {
  if (!opts.fastRuntime) return opts.primaryRuntime;
  return resolveOptionalRuntime(opts.fastRuntime, opts, 'DISCOCLAW_FAST_RUNTIME') ?? opts.primaryRuntime;
}

export function collectActiveProviders(opts: {
  primaryRuntimeId: string;
  fastRuntime?: RuntimeAdapter;
  forgeCommandsEnabled: boolean;
  drafterRuntime: RuntimeAdapter | undefined;
  auditorRuntime: RuntimeAdapter | undefined;
}): Set<string> {
  const activeProviders = new Set<string>([opts.primaryRuntimeId]);
  if (opts.fastRuntime?.id) activeProviders.add(opts.fastRuntime.id);
  if (!opts.forgeCommandsEnabled) return activeProviders;
  if (opts.drafterRuntime?.id) activeProviders.add(opts.drafterRuntime.id);
  if (opts.auditorRuntime?.id) activeProviders.add(opts.auditorRuntime.id);
  return activeProviders;
}

export type WrapRuntimeWithGlobalPoliciesOptions = {
  runtime: RuntimeAdapter;
  maxConcurrentInvocations: number;
  limiter?: ConcurrencyLimiter | null;
  log?: RuntimeLog;
  env?: NodeJS.ProcessEnv;
  globalSupervisorEnabled?: boolean;
  globalSupervisorAuditStream?: 'stdout' | 'stderr';
  globalSupervisorLimits?: Partial<GlobalSupervisorLimits>;
};

/**
 * Apply runtime wrappers in a fixed order:
 * 1) Global supervisor loop (plan -> execute -> evaluate -> decide)
 * 2) Shared concurrency limiter
 */
export function wrapRuntimeWithGlobalPolicies(opts: WrapRuntimeWithGlobalPoliciesOptions): RuntimeAdapter {
  const supervised = withGlobalSupervisor(opts.runtime, {
    enabled: opts.globalSupervisorEnabled,
    env: opts.env,
    auditStream: opts.globalSupervisorAuditStream,
    limits: opts.globalSupervisorLimits,
  });
  return withConcurrencyLimit(supervised, {
    maxConcurrentInvocations: opts.maxConcurrentInvocations,
    limiter: opts.limiter,
    log: opts.log,
  });
}

export type RegisterRuntimeWithGlobalPoliciesOptions = WrapRuntimeWithGlobalPoliciesOptions & {
  name: string;
  runtimeRegistry: RuntimeRegistry;
};

export function registerRuntimeWithGlobalPolicies(opts: RegisterRuntimeWithGlobalPoliciesOptions): RuntimeAdapter {
  const wrapped = wrapRuntimeWithGlobalPolicies(opts);
  opts.runtimeRegistry.register(opts.name, wrapped);
  return wrapped;
}
