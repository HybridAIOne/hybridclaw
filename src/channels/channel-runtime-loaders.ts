/**
 * Lazy loaders for the channel modules that pull in a heavy SDK (discord.js,
 * @slack/bolt, imapflow/mailparser/nodemailer).
 *
 * Core gateway code reaches these modules only through here, so a gateway
 * that never configures a channel never loads its SDK; each costs roughly
 * 5-20 MB of heap, multiplied by every cloud sandbox. `current()` exposes an
 * already-loaded module to sync callers and to shutdown, which must not
 * trigger a load. `tests/gateway-startup-imports.test.ts` guards the boundary.
 *
 * NOT a channel registry: it decides nothing about which channels start.
 */

interface LazyModule<T> {
  load(): Promise<T>;
  current(): T | null;
}

function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    load: () => {
      pending ??= importer().then(
        (module) => {
          loaded = module;
          return module;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    current: () => loaded,
  };
}

export const discordRuntimeLoader = lazyModule(
  () => import('./discord/runtime.js'),
);
export const emailRuntimeLoader = lazyModule(
  () => import('./email/runtime.js'),
);
export const emailAdminMailboxLoader = lazyModule(
  () => import('./email/admin-mailbox.js'),
);
export const slackRuntimeLoader = lazyModule(
  () => import('./slack/runtime.js'),
);

export async function stopDiscordRuntime(): Promise<void> {
  await discordRuntimeLoader.current()?.shutdownDiscord();
}
export async function stopEmailRuntime(): Promise<void> {
  await emailRuntimeLoader.current()?.shutdownEmail();
}
export async function stopSlackRuntime(): Promise<void> {
  await slackRuntimeLoader.current()?.shutdownSlack();
}
