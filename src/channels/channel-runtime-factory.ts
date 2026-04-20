import type { ChannelInfo, ChannelKind } from './channel.js';
import { registerChannel } from './channel-registry.js';

type MaybePromise<T> = T | Promise<T>;
type Registration = string | null | undefined;
type BaseRuntimeOptions = {
  kind: ChannelKind;
  capabilities: ChannelInfo['capabilities'];
  cleanup?: () => MaybePromise<void>;
};
type RuntimeOptionsWithoutConfig<Handler> = BaseRuntimeOptions & {
  resolveConfig?: undefined;
  resolveRegistration?: () => MaybePromise<Registration>;
  start: (params: { handler: Handler }) => MaybePromise<void>;
};
type RuntimeOptionsWithConfig<Handler, Config> = BaseRuntimeOptions & {
  resolveConfig: () => MaybePromise<Config>;
  resolveRegistration?: (config: Config) => MaybePromise<Registration>;
  start: (params: { handler: Handler; config: Config }) => MaybePromise<void>;
};
type RuntimeOptions<Handler, Config = never> =
  | RuntimeOptionsWithoutConfig<Handler>
  | RuntimeOptionsWithConfig<Handler, Config>;
type RuntimeLifecycle<Handler> = {
  init: (handler: Handler) => Promise<void>;
  shutdown: () => Promise<void>;
};

function registerResolvedChannel(
  kind: ChannelKind,
  capabilities: ChannelInfo['capabilities'],
  registration: Registration,
): void {
  registerChannel({
    kind,
    id: registration?.trim() || kind,
    capabilities,
  });
}

function hasResolvedConfig<Handler, Config>(
  options: RuntimeOptions<Handler, Config>,
): options is RuntimeOptionsWithConfig<Handler, Config> {
  return typeof options.resolveConfig === 'function';
}

// Keep this helper scoped to runtimes that only need init dedupe,
// registerChannel(), and a no-arg shutdown cleanup. Current intentional
// opt-outs:
// - Discord owns client login/readiness and returns a live Client from init.
// - Telegram caches resolved bot identity/config state alongside its poll task.
// - Voice supports drain-aware shutdown and websocket availability transitions.
export function createChannelRuntime<Handler = void>() {
  return <Config = never>(
    options: RuntimeOptions<Handler, Config>,
  ): RuntimeLifecycle<Handler> => {
    let initialized = false;
    let initializing: Promise<void> | undefined;
    let generation = 0;

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
              await options.cleanup?.();
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
      shutdown: async (): Promise<void> => {
        generation += 1;
        try {
          await options.cleanup?.();
        } finally {
          initialized = false;
          initializing = undefined;
        }
      },
    };
  };
}
