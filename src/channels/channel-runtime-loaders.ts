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

export interface LazyModule<T> {
  load(): Promise<T>;
  current(): T | null;
}

function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    load: () => {
      pending ??= importer().then((module) => {
        loaded = module;
        return module;
      });
      return pending;
    },
    current: () => loaded,
  };
}

export const discordRuntime = lazyModule(() => import('./discord/runtime.js'));
export const emailRuntime = lazyModule(() => import('./email/runtime.js'));
export const emailAdminMailbox = lazyModule(
  () => import('./email/admin-mailbox.js'),
);
export const slackRuntime = lazyModule(() => import('./slack/runtime.js'));

// Stopping a runtime that never loaded is a no-op, and must not load its SDK.
export async function stopDiscordRuntime(): Promise<void> {
  await discordRuntime.current()?.shutdownDiscord();
}
export async function stopEmailRuntime(): Promise<void> {
  await emailRuntime.current()?.shutdownEmail();
}
export async function stopSlackRuntime(): Promise<void> {
  await slackRuntime.current()?.shutdownSlack();
}
