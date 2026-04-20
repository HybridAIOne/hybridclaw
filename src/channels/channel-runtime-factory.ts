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

  return {
    init: (handler: Handler): Promise<void> => {
      if (initialized) return Promise.resolve();
      if (!initializing) {
        initializing = (async () => {
          const config = await options.resolveConfig?.();
          const registration = await options.resolveRegistration?.(
            config as Config,
          );
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
          initialized = true;
        })().finally(() => {
          initializing = undefined;
        });
      }
      return initializing;
    },
    shutdown: async (...args: Args): Promise<void> => {
      try {
        await options.cleanup?.(...args);
      } finally {
        initialized = false;
        initializing = undefined;
      }
    },
  };
}
