import type { ChannelInfo, ChannelKind } from './channel.js';
import { registerChannel } from './channel-registry.js';

type MaybePromise<T> = T | Promise<T>;
type Registration =
  | string
  | { id?: string | null; capabilities?: ChannelInfo['capabilities'] }
  | null
  | undefined;
type RuntimeOptions<Handler, Config, Args extends unknown[]> = {
  kind: ChannelKind;
  capabilities: ChannelInfo['capabilities'];
  resolveConfig?: () => MaybePromise<Config>;
  resolveRegistration?: (config: Config) => MaybePromise<Registration>;
  start: (params: { handler: Handler; config: Config }) => MaybePromise<void>;
  cleanup?: (...args: Args) => MaybePromise<void>;
};

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
          const config = await options.resolveConfig?.();
          if (initGeneration !== generation) return;
          const registration = await options.resolveRegistration?.(
            config as Config,
          );
          if (initGeneration !== generation) return;
          const resolved =
            typeof registration === 'string'
              ? { id: registration }
              : registration;
          registerChannel({
            kind: options.kind,
            id: String(resolved?.id || options.kind).trim() || options.kind,
            capabilities: resolved?.capabilities || options.capabilities,
          });
          await options.start({ handler, config: config as Config });
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
