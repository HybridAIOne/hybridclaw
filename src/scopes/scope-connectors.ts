/**
 * Which connector tools a scoped chat may use. Platform connector tools are
 * `hybridai__<service>__<tool>`; a scoped chat keeps the platform's own
 * tools (`hybridai__web_search`, one segment), the public catalog tools the
 * directory marks `kind: "tool"`, and the personal connectors its scope
 * lists. Every other service is blocked, also one the directory does not
 * name, and all of them when the directory cannot be read (fail closed).
 *
 * The result is `blockedTools` entries for the agent process: `*` matches any
 * run of characters, and an entry starting with `!` exempts what it matches
 * from the `*` entries (`container/src/blocked-tools.ts`).
 * NOT account-level limits (one Google account per scope): not built.
 */
import { fetchHybridAIConnectorDirectory } from '../gateway/gateway-admin-connectors.js';
import { logger } from '../logger.js';
import { DEVICE_CONNECTOR_ID, type Scope } from './scope-store.js';

export const ALL_CONNECTOR_SERVICE_TOOLS = 'hybridai__*__*';

// Platform tool namespaces that differ from their connector id, as
// `_DIRECT_API_CONNECTORS` in the platform's connectors gateway_service.py
// names them (read 2026-10-09). A namespace missing here stays blocked.
const CONNECTOR_TOOL_NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  google: ['google_workspace'],
  microsoft365: ['microsoft_graph'],
  github: ['github_api'],
};

export interface ConnectorDirectoryEntry {
  id: string;
  /** "tool": public, no account. Anything else is a personal account. */
  kind: 'tool' | 'connector';
}

// 5 min (engineering choice, 2026-10-09): connectors change when the user
// connects one, which the phone does minutes before using it in a scope; a
// failed read is retried after 30 s.
const DIRECTORY_TTL_MS = 5 * 60_000;
const DIRECTORY_FAILURE_TTL_MS = 30_000;
const DIRECTORY_TIMEOUT_MS = 5_000;

let cached: {
  entries: ConnectorDirectoryEntry[] | null;
  expiresAt: number;
} | null = null;
let inFlight: Promise<ConnectorDirectoryEntry[] | null> | null = null;

export function parseConnectorDirectory(
  payload: Record<string, unknown>,
): ConnectorDirectoryEntry[] | null {
  if (!Array.isArray(payload.connectors)) return null;
  const entries: ConnectorDirectoryEntry[] = [];
  for (const raw of payload.connectors) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    entries.push({ id, kind: record.kind === 'tool' ? 'tool' : 'connector' });
  }
  return entries;
}

async function loadConnectorDirectory(): Promise<
  ConnectorDirectoryEntry[] | null
> {
  const payload = await fetchHybridAIConnectorDirectory(
    AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
  ).catch(() => null);
  return payload ? parseConnectorDirectory(payload) : null;
}

/** The platform's connector directory, cached; null when unreadable. */
export async function getConnectorDirectory(): Promise<
  ConnectorDirectoryEntry[] | null
> {
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  inFlight ??= loadConnectorDirectory().then((entries) => {
    cached = {
      entries,
      expiresAt:
        Date.now() + (entries ? DIRECTORY_TTL_MS : DIRECTORY_FAILURE_TTL_MS),
    };
    if (!entries) {
      logger.warn(
        'Connector directory unavailable; scoped chats get no connector tools',
      );
    }
    return entries;
  });
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export function resetConnectorDirectoryCacheForTests(): void {
  cached = null;
  inFlight = null;
}

function toolNamespaces(connectorId: string): string[] {
  return [connectorId, ...(CONNECTOR_TOOL_NAMESPACES[connectorId] ?? [])];
}

/** `blockedTools` entries for a chat in `scope`. */
export function scopeBlockedTools(
  scope: Pick<Scope, 'connectors'>,
  directory: readonly ConnectorDirectoryEntry[] | null,
): string[] {
  const blocked = scope.connectors.includes(DEVICE_CONNECTOR_ID)
    ? []
    : ['device_data'];
  blocked.push(ALL_CONNECTOR_SERVICE_TOOLS);
  if (!directory) return blocked;
  const allowed = new Set<string>();
  for (const entry of directory) {
    if (entry.kind === 'tool' || scope.connectors.includes(entry.id)) {
      for (const namespace of toolNamespaces(entry.id)) allowed.add(namespace);
    }
  }
  for (const namespace of [...allowed].sort()) {
    blocked.push(`!hybridai__${namespace}__*`);
  }
  return blocked;
}
