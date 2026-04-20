import type { ChannelInfo, ChannelKind } from './channel.js';
import { registerChannel } from './channel-registry.js';

type MaybePromise<T> = T | Promise<T>;
type Registration =
  | string
  | { id?: string | null; capabilities?: ChannelInfo['capabilities'] }
  | null
  | undefined;
type BaseRuntimeOptions<Args extends unknown[]> = {
  kind: ChannelKind;
  capabilities: ChannelInfo['capabilities'];
  cleanup?: (...args: Args) => MaybePromise<void>;
};
type RuntimeOptionsWithoutConfig<
  Handler,
  Args extends unknown[],
> = BaseRuntimeOptions<Args> & {
  resolveConfig?: undefined;
  resolveRegistration?: () => MaybePromise<Registration>;
  start: (params: { handler: Handler }) => MaybePromise<void>;
};
type RuntimeOptionsWithConfig<
  Handler,
  Config,
  Args extends unknown[],
> = BaseRuntimeOptions<Args> & {
  resolveConfig: () => MaybePromise<Config>;
  resolveRegistration?: (config: Config) => MaybePromise<Registration>;
  start: (params: { handler: Handler; config: Config }) => MaybePromise<void>;
};
type RuntimeOptions<Handler, Config, Args extends unknown[]> =
  | RuntimeOptionsWithoutConfig<Handler, Args>
  | RuntimeOptionsWithConfig<Handler, Config, Args>;
type RuntimeLifecycle<Handler, Args extends unknown[]> = {
  init: (handler: Handler) => Promise<void>;
  shutdown: (...args: Args) => Promise<void>;
};

function registerResolvedChannel(
  kind: ChannelKind,
  capabilities: ChannelInfo['capabilities'],
  registration: Registration,
): void {
  const resolved =
    typeof registration === 'string' ? { id: registration } : registration;
  registerChannel({
    kind,
    id: String(resolved?.id || kind).trim() || kind,
    capabilities: resolved?.capabilities || capabilities,
  });
}

function hasResolvedConfig<Handler, Config, Args extends unknown[]>(
  options: RuntimeOptions<Handler, Config, Args>,
): options is RuntimeOptionsWithConfig<Handler, Config, Args> {
  return typeof options.resolveConfig === 'function';
}

export function createChannelRuntime<
  Handler = void,
  Args extends unknown[] = [],
>(
  options: RuntimeOptionsWithoutConfig<Handler, Args>,
): RuntimeLifecycle<Handler, Args>;
export function createChannelRuntime<
  Handler,
  Config,
  Args extends unknown[] = [],
>(
  options: RuntimeOptionsWithConfig<Handler, Config, Args>,
): RuntimeLifecycle<Handler, Args>;

export function createChannelRuntime<
  Handler = void,
  Config = void,
  Args extends unknown[] = [],
>(options: RuntimeOptions<Handler, Config, Args>) {
  let initialized = false;
  let initializing: Promise<void> | undefined;
  let generation = 0;
  let shutdownArgs: Args | undefined;

  return {
    init: (handler: Handler): Promise<void> => {
      if (initialized) return Promise.resolve();
      if (!initializing) {
        const initGeneration = generation;
        const initPromise = (async () => {
          if (hasResolvedConfig(options)) {
            const config = await options.resolveConfig();
            if (initGeneration !== generation) return;
            const registration = await options.resolveRegistration?.(config);
            if (initGeneration !== generation) return;
            registerResolvedChannel(
              options.kind,
              options.capabilities,
              registration,
            );
            await options.start({ handler, config });
          } else {
            const registration = await options.resolveRegistration?.();
            if (initGeneration !== generation) return;
            registerResolvedChannel(
              options.kind,
              options.capabilities,
              registration,
            );
            await options.start({ handler });
          }
          if (initGeneration !== generation) {
            if (shutdownArgs) {
              await options.cleanup?.(...shutdownArgs);
            }
            return;
          }
          initialized = true;
        })().finally(() => {
          if (initializing === initPromise) {
            initializing = undefined;
          }
        });
        initializing = initPromise;
      }
      return initializing;
    },
    shutdown: async (...args: Args): Promise<void> => {
      generation += 1;
      shutdownArgs = args;
      try {
        await options.cleanup?.(...args);
      } finally {
        initialized = false;
        initializing = undefined;
      }
    },
  };
}
