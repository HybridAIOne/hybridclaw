/**
 * Gateway browser session cache — owns open `BrowserSession` handles across
 * tool calls and ensures every cached session is closed on explicit close,
 * config change, plugin unload/reload, or gateway shutdown.
 *
 * Each entry captures its provider's `dispose` hook and registration
 * fingerprint at creation time and removes itself from the map before awaiting
 * teardown, so concurrent closes never double-stop a remote session. Shutdown
 * and unload disposals are bounded by a short timeout with an `AbortSignal` so
 * a hung provider cannot block gateway shutdown or plugin reloads.
 *
 * NOT the provider registry (`provider-factory.ts` maps a kind to its plugin)
 * and not the HTTP route handler (`gateway-http-server.ts`).
 */
import { randomUUID } from 'node:crypto';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { logger } from '../logger.js';
import type { BrowserProvider, BrowserSession } from './provider.js';
import {
  type BrowserProviderDisposeContext,
  type BrowserProviderDisposeReason,
  browserProviderFingerprint,
  createBrowserProvider,
  getBrowserProviderDispose,
  LOCAL_BROWSER_PROVIDER,
} from './provider-factory.js';
import { browserSessionConfigSignature } from './session-config-signature.js';

// 4s (below gateway.ts SHUTDOWN_STEP_TIMEOUT_MS = 5s): gives cloud stop/delete
// requests time to finish while ensuring the per-session AbortController aborts
// hung providers cleanly before the outer gateway shutdown timer fires.
export const DEFAULT_BROWSER_SESSION_DISPOSE_TIMEOUT_MS = 4_000;

export interface GatewayBrowserSessionEntry {
  providerKind: string;
  provider: BrowserProvider;
  dispose?: (context: BrowserProviderDisposeContext) => Promise<void> | void;
  configSignature: string;
  registrationFingerprint: string;
  session: BrowserSession;
  skillName: string;
}

const gatewayBrowserSessions = new Map<string, GatewayBrowserSessionEntry>();
let closeGeneration = 0;

async function disposeEntry(
  sessionId: string,
  entry: GatewayBrowserSessionEntry,
  reason: BrowserProviderDisposeReason,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve()
    .then(() =>
      entry.dispose
        ? entry.dispose({
            provider: entry.provider,
            session: entry.session,
            reason,
            signal: controller.signal,
          })
        : entry.provider.closeSession(entry.session, {
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
        new Error(`Browser session dispose timed out after ${timeoutMs}ms`),
      );
      resolve({ status: 'timeout' });
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    const result = await Promise.race([operation, timeout]);
    if (result.status === 'error') {
      logger.warn(
        {
          err: result.error,
          sessionId,
          provider: entry.providerKind,
          reason,
        },
        'Failed to close cached gateway browser session',
      );
    } else if (result.status === 'timeout') {
      logger.warn(
        {
          sessionId,
          provider: entry.providerKind,
          reason,
          timeoutMs,
        },
        'Timed out closing cached gateway browser session; continuing',
      );
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
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
    disposeTimeoutMs?: number;
  },
): Promise<GatewayBrowserSessionEntry> {
  const browserConfig = getRuntimeConfig().browser;
  const configSignature = browserSessionConfigSignature(browserConfig);
  const existing = gatewayBrowserSessions.get(sessionId);
  if (existing) {
    if (existing.configSignature === configSignature) return existing;
    gatewayBrowserSessions.delete(sessionId);
    await disposeEntry(
      sessionId,
      existing,
      'config-change',
      opts?.disposeTimeoutMs ?? DEFAULT_BROWSER_SESSION_DISPOSE_TIMEOUT_MS,
    );
  }
  const providerKind = browserConfig.provider;
  const registrationFingerprint = browserProviderFingerprint(providerKind);
  const dispose = getBrowserProviderDispose(providerKind);
  const provider = createBrowserProvider(browserConfig, {
    pluginLoadError: opts?.pluginLoadError,
  });
  const skillName = String(opts?.skillName || '').trim() || 'browser';
  const launchGeneration = closeGeneration;
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
  const entry: GatewayBrowserSessionEntry = {
    providerKind,
    provider,
    dispose,
    configSignature,
    registrationFingerprint,
    session,
    skillName,
  };
  // If shutdown or a provider unload happened while launchSession was in
  // flight, tear down the brand-new session instead of caching an orphan.
  const providerUnloaded =
    providerKind !== LOCAL_BROWSER_PROVIDER &&
    browserProviderFingerprint(providerKind) !== registrationFingerprint;
  if (closeGeneration !== launchGeneration || providerUnloaded) {
    await disposeEntry(
      sessionId,
      entry,
      providerUnloaded ? 'plugin-unload' : 'shutdown',
      opts?.disposeTimeoutMs ?? DEFAULT_BROWSER_SESSION_DISPOSE_TIMEOUT_MS,
    );
    throw new Error(
      `Browser session for provider "${providerKind}" was closed while launching.`,
    );
  }
  gatewayBrowserSessions.set(sessionId, entry);
  return entry;
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

export interface CloseBrowserSessionsOptions {
  reason: BrowserProviderDisposeReason;
  timeoutMs?: number;
  predicate?: (entry: GatewayBrowserSessionEntry) => boolean;
}

export async function closeGatewayBrowserSessions(
  options: CloseBrowserSessionsOptions,
): Promise<number> {
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_BROWSER_SESSION_DISPOSE_TIMEOUT_MS;
  const predicate = options.predicate;
  if (!predicate) {
    closeGeneration += 1;
  }
  const toClose: Array<[string, GatewayBrowserSessionEntry]> = [];
  for (const [sessionId, entry] of gatewayBrowserSessions.entries()) {
    if (!predicate || predicate(entry)) {
      gatewayBrowserSessions.delete(sessionId);
      toClose.push([sessionId, entry]);
    }
  }
  if (toClose.length === 0) return 0;
  await Promise.allSettled(
    toClose.map(([sessionId, entry]) =>
      disposeEntry(sessionId, entry, options.reason, timeoutMs),
    ),
  );
  return toClose.length;
}

export async function closeAllGatewayBrowserSessions(
  reason: BrowserProviderDisposeReason = 'shutdown',
  timeoutMs?: number,
): Promise<number> {
  return await closeGatewayBrowserSessions({ reason, timeoutMs });
}

export async function closePluginGatewayBrowserSessions(
  reason: BrowserProviderDisposeReason = 'plugin-unload',
  timeoutMs?: number,
): Promise<number> {
  return await closeGatewayBrowserSessions({
    reason,
    timeoutMs,
    predicate: (entry) => entry.providerKind !== LOCAL_BROWSER_PROVIDER,
  });
}

export interface PluginBrowserShutdownOptions {
  preserveBrowserSessions?: boolean;
  browserSessionCloseReason?: BrowserProviderDisposeReason;
  browserSessionCloseTimeoutMs?: number;
}

export async function closeBrowserSessionsForPluginShutdown(
  opts?: PluginBrowserShutdownOptions,
): Promise<void> {
  if (opts?.preserveBrowserSessions) return;
  await closePluginGatewayBrowserSessions(
    opts?.browserSessionCloseReason ?? 'plugin-unload',
    opts?.browserSessionCloseTimeoutMs,
  );
}

export async function closeStaleGatewayBrowserSessions(
  reason: BrowserProviderDisposeReason = 'plugin-reload',
  timeoutMs?: number,
): Promise<number> {
  const currentConfig = getRuntimeConfig().browser;
  const currentSignature = browserSessionConfigSignature(currentConfig);
  return await closeGatewayBrowserSessions({
    reason,
    timeoutMs,
    predicate: (entry) => {
      if (reason === 'config-change') {
        return entry.configSignature !== currentSignature;
      }
      if (entry.providerKind === LOCAL_BROWSER_PROVIDER) return false;
      return (
        browserProviderFingerprint(entry.providerKind) !==
        entry.registrationFingerprint
      );
    },
  });
}
