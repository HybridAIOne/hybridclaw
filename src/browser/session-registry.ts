/**
 * Gateway browser session cache — owns open `BrowserSession` handles across
 * tool calls and closes every cached session on explicit close, browser config
 * change, plugin unload/reload, or gateway shutdown.
 *
 * Concurrent launches for one `sessionId` share a single launch. A launch is
 * discarded (and its session closed) when its provider kind's close generation
 * moves while `launchSession` is in flight, so only closes that target that
 * kind invalidate it; an unrelated plugin reload does not. Shutdown is sticky:
 * once it starts, no new session launches. Each entry leaves the map before
 * `provider.closeSession(session, { signal })` runs, bounded by a timeout, so
 * concurrent closes never double-stop and a hung provider never stalls
 * shutdown.
 *
 * NOT the provider registry (`provider-factory.ts` maps a kind to its plugin)
 * and not the HTTP route handler (`gateway-http-server.ts`).
 */
import { randomUUID } from 'node:crypto';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import type { BrowserProvider, BrowserSession } from './provider.js';
import {
  createBrowserProvider,
  LOCAL_BROWSER_PROVIDER,
} from './provider-factory.js';
import { browserSessionConfigSignature } from './session-config-signature.js';

// 4s (below gateway.ts SHUTDOWN_STEP_TIMEOUT_MS = 5s): gives cloud stop/delete
// requests time to finish while ensuring the per-session AbortController aborts
// hung providers cleanly before the outer gateway shutdown timer fires.
const DEFAULT_CLOSE_TIMEOUT_MS = 4_000;

type CloseReason =
  | 'shutdown'
  | 'plugin-unload'
  | 'plugin-reload'
  | 'config-change';

export interface GatewayBrowserSessionEntry {
  providerKind: string;
  provider: BrowserProvider;
  configSignature: string;
  session: BrowserSession;
  skillName: string;
}

interface PendingLaunch {
  providerKind: string;
  configSignature: string;
  promise: Promise<GatewayBrowserSessionEntry>;
}

const gatewayBrowserSessions = new Map<string, GatewayBrowserSessionEntry>();
const pendingLaunches = new Map<string, PendingLaunch>();
let shuttingDown = false;
let closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS;
// Plugin reloads in progress that keep unchanged sessions; plugin shutdowns
// inside one leave sessions open and the reload closes outdated ones after.
let keepingSessionsReloads = 0;
// Close generations: bumped for every plugin provider kind, or for one kind.
let pluginCloseGeneration = 0;
const kindCloseGenerations = new Map<string, number>();

function closeGeneration(providerKind: string): number {
  const pluginGeneration =
    providerKind === LOCAL_BROWSER_PROVIDER ? 0 : pluginCloseGeneration;
  return pluginGeneration + (kindCloseGenerations.get(providerKind) ?? 0);
}

function isPluginEntry(entry: { providerKind: string }): boolean {
  return entry.providerKind !== LOCAL_BROWSER_PROVIDER;
}

async function closeEntry(
  sessionId: string,
  entry: GatewayBrowserSessionEntry,
  reason: CloseReason,
): Promise<void> {
  const timeoutMs = closeTimeoutMs;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve()
    .then(() =>
      entry.provider.closeSession(entry.session, {
        signal: controller.signal,
      }),
    )
    .then(
      () => ({ status: 'done' as const }),
      (error) => ({ status: 'error' as const, error }),
    );
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(
        new Error(`Browser session close timed out after ${timeoutMs}ms`),
      );
      resolve({ status: 'timeout' });
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const result = await Promise.race([operation, timeout]);
    const fields = { sessionId, provider: entry.providerKind, reason };
    if (result.status === 'error') {
      logger.warn(
        { err: result.error, ...fields },
        'Failed to close cached gateway browser session',
      );
    } else if (result.status === 'timeout') {
      logger.warn(
        { ...fields, timeoutMs },
        'Timed out closing cached gateway browser session; continuing',
      );
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function closeSessions(
  reason: CloseReason,
  matches: (entry: GatewayBrowserSessionEntry) => boolean,
): Promise<number> {
  const closing = [...gatewayBrowserSessions].filter(([, entry]) =>
    matches(entry),
  );
  for (const [sessionId] of closing) gatewayBrowserSessions.delete(sessionId);
  await Promise.allSettled(
    closing.map(([sessionId, entry]) => closeEntry(sessionId, entry, reason)),
  );
  return closing.length;
}

function refuseDuringShutdown(): void {
  if (shuttingDown) {
    throw new Error(
      'Gateway is shutting down; refusing to launch browser session.',
    );
  }
}

export function getCachedGatewayBrowserSession(
  sessionId: string,
): GatewayBrowserSessionEntry | undefined {
  return gatewayBrowserSessions.get(sessionId);
}

export async function getOrCreateGatewayBrowserSession(
  sessionId: string,
  agentId: string,
  opts?: {
    headed?: boolean;
    skillName?: string;
    pluginLoadError?: string;
  },
): Promise<GatewayBrowserSessionEntry> {
  refuseDuringShutdown();
  const browserConfig = getRuntimeConfig().browser;
  const configSignature = browserSessionConfigSignature(browserConfig);
  const existing = gatewayBrowserSessions.get(sessionId);
  if (existing?.configSignature === configSignature) return existing;
  const pending = pendingLaunches.get(sessionId);
  if (pending?.configSignature === configSignature) {
    return await pending.promise;
  }
  if (pending) {
    await pending.promise.catch(() => undefined);
    return await getOrCreateGatewayBrowserSession(sessionId, agentId, opts);
  }
  if (existing) gatewayBrowserSessions.delete(sessionId);

  const providerKind = browserConfig.provider;
  const launchGeneration = closeGeneration(providerKind);
  const launch = async (): Promise<GatewayBrowserSessionEntry> => {
    if (existing) await closeEntry(sessionId, existing, 'config-change');
    refuseDuringShutdown();
    const provider = createBrowserProvider(browserConfig, {
      pluginLoadError: opts?.pluginLoadError,
    });
    const skillName = String(opts?.skillName || '').trim() || 'browser';
    const session = await provider.launchSession({
      headed: opts?.headed,
      timeoutMs: 60_000,
      metering: {
        sessionId,
        agentId,
        auditRunId: `gateway_browser_${randomUUID().replace(/-/g, '')}`,
        skillName,
      },
    });
    const entry = {
      providerKind,
      provider,
      configSignature,
      session,
      skillName,
    };
    if (shuttingDown || closeGeneration(providerKind) !== launchGeneration) {
      await closeEntry(
        sessionId,
        entry,
        shuttingDown ? 'shutdown' : 'plugin-reload',
      );
      throw new Error(
        `Browser session for provider "${providerKind}" was closed while launching.`,
      );
    }
    gatewayBrowserSessions.set(sessionId, entry);
    return entry;
  };

  const record: PendingLaunch = {
    providerKind,
    configSignature,
    promise: launch(),
  };
  pendingLaunches.set(sessionId, record);
  try {
    return await record.promise;
  } finally {
    if (pendingLaunches.get(sessionId) === record) {
      pendingLaunches.delete(sessionId);
    }
  }
}

export async function closeGatewayBrowserSession(
  sessionId: string,
): Promise<boolean> {
  const active = gatewayBrowserSessions.get(sessionId);
  if (!active) return false;
  gatewayBrowserSessions.delete(sessionId);
  await active.provider.closeSession(active.session);
  return true;
}

/** Gateway shutdown: closes every session and refuses later launches. */
export async function closeAllGatewayBrowserSessions(): Promise<number> {
  shuttingDown = true;
  return await closeSessions('shutdown', () => true);
}

/** Closes sessions, cached or launching, whose browser config is outdated. */
export async function closeBrowserSessionsOnConfigChange(): Promise<number> {
  return await closeOutdatedBrowserSessions('config-change');
}

async function closeOutdatedBrowserSessions(
  reason: CloseReason,
): Promise<number> {
  const current = browserSessionConfigSignature(getRuntimeConfig().browser);
  for (const pending of pendingLaunches.values()) {
    if (pending.configSignature === current) continue;
    const generation = kindCloseGenerations.get(pending.providerKind) ?? 0;
    kindCloseGenerations.set(pending.providerKind, generation + 1);
  }
  // The signature carries the provider's plugin fingerprint, so a provider
  // whose plugin or plugin config changed, or that is gone, is outdated too.
  return await closeSessions(
    reason,
    (entry) => entry.configSignature !== current,
  );
}

async function closePluginSessions(reason: CloseReason): Promise<number> {
  pluginCloseGeneration += 1;
  return await closeSessions(reason, isPluginEntry);
}

/**
 * Plugin unload: closes every plugin-provided session unless a reload that
 * keeps unchanged sessions is in progress.
 */
export async function closePluginBrowserSessions(): Promise<void> {
  if (keepingSessionsReloads > 0) return;
  await closePluginSessions('plugin-unload');
}

/**
 * Runs a plugin reload. By default sessions whose provider and config are
 * unchanged stay open and outdated ones close afterwards; `'close-browsers'`
 * (explicit `/plugin reload` or reinstall) closes every plugin session first.
 */
export async function reloadKeepingBrowserSessions<T>(
  reload: () => Promise<T>,
  mode?: 'close-browsers',
): Promise<T> {
  if (mode === 'close-browsers') {
    await closePluginSessions('plugin-reload');
    return await reload();
  }
  keepingSessionsReloads += 1;
  try {
    return await reload();
  } finally {
    keepingSessionsReloads -= 1;
    // A concurrent reload that is still running sweeps when it finishes.
    if (keepingSessionsReloads === 0) {
      await closeOutdatedBrowserSessions('plugin-reload');
    }
  }
}

export function setBrowserSessionCloseTimeoutForTests(timeoutMs: number): void {
  closeTimeoutMs = timeoutMs;
}

export function resetGatewayBrowserSessionsForTests(): void {
  gatewayBrowserSessions.clear();
  pendingLaunches.clear();
  shuttingDown = false;
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS;
  keepingSessionsReloads = 0;
  pluginCloseGeneration = 0;
  kindCloseGenerations.clear();
}
