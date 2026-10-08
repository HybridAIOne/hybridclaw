/**
 * Lazy loaders for the channel modules that pull in a heavy SDK (discord.js,
 * @slack/bolt, imapflow/mailparser/nodemailer, botbuilder).
 *
 * Core gateway code reaches these modules only through here, so a gateway
 * that never configures a channel never loads its SDK; each costs roughly
 * 5-20 MB of heap, multiplied by every cloud sandbox. `current()` exposes an
 * already-loaded module to sync callers and to shutdown, which must not
 * trigger a load. Channel runtimes start through `loadForStart()` and stop
 * through `stop()`, so a stop during the SDK import cancels the pending
 * start. `tests/gateway-startup-imports.test.ts` guards the boundary.
 *
 * NOT a channel registry: it decides nothing about which channels start.
 */

import { type LazyModule, lazyModule } from '../utils/lazy-module.js';

interface ChannelRuntimeModule<T> extends LazyModule<T> {
  loadForStart(): Promise<T | null>;
  stop(): Promise<void>;
}

// Callers must init in the same continuation that receives the module.
function channelRuntimeModule<T>(
  importer: () => Promise<T>,
  shutdown: (module: T) => Promise<void>,
): ChannelRuntimeModule<T> {
  const module = lazyModule(importer);
  let stops = 0;
  return {
    ...module,
    loadForStart: async () => {
      const stopsBefore = stops;
      const loaded = await module.load();
      return stops === stopsBefore ? loaded : null;
    },
    stop: async () => {
      stops += 1;
      const loaded = module.current();
      if (loaded) await shutdown(loaded);
    },
  };
}

export const discordRuntimeLoader = channelRuntimeModule(
  () => import('./discord/runtime.js'),
  (runtime) => runtime.shutdownDiscord(),
);
export const emailRuntimeLoader = channelRuntimeModule(
  () => import('./email/runtime.js'),
  (runtime) => runtime.shutdownEmail(),
);
export const emailAdminMailboxLoader = lazyModule(
  () => import('./email/admin-mailbox.js'),
);
export const msteamsRuntimeLoader = lazyModule(
  () => import('./msteams/runtime.js'),
);
export const msteamsAttachmentsLoader = lazyModule(
  () => import('./msteams/attachments.js'),
);
export const slackRuntimeLoader = channelRuntimeModule(
  () => import('./slack/runtime.js'),
  (runtime) => runtime.shutdownSlack(),
);
