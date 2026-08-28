/**
 * Official channel-plugin catalog — the source of truth for install-on-demand
 * transports. Entries are curated code provenance, not runtime availability.
 */
import type { ChannelKind } from './channel.js';
import { hasChannelTransport } from './channel-transport.js';

export interface ChannelPluginCatalogEntry {
  channel: ChannelKind;
  pluginId: string;
  installSource: string;
}

export interface OfficialChannelPluginCatalogEntry
  extends ChannelPluginCatalogEntry {
  name: string;
  description: string;
}

export interface ChannelPluginStatus {
  channel: ChannelKind;
  pluginId: string;
  installSource: string;
  transportAvailable: boolean;
}

// Official web-install allowlist (owner call, 2026-08-25): third-party catalog
// discovery and publisher verification are deliberately deferred.
const CHANNEL_PLUGIN_CATALOG = {
  line: {
    pluginId: 'line',
    name: 'LINE',
    description: 'Official LINE personal-account transport.',
    installSource: 'line',
  },
  whatsapp: {
    pluginId: 'whatsapp',
    name: 'WhatsApp',
    description: 'Official WhatsApp transport maintained by HybridAIOne.',
    installSource:
      'https://github.com/HybridAIOne/hybridclaw-whatsapp/releases/download/v0.1.0/hybridaione-hybridclaw-whatsapp-0.1.0.tgz',
  },
} as const satisfies Partial<
  Record<ChannelKind, Omit<OfficialChannelPluginCatalogEntry, 'channel'>>
>;

export function getChannelPluginCatalogEntry(
  channel: ChannelKind,
): ChannelPluginCatalogEntry | undefined {
  const entry =
    CHANNEL_PLUGIN_CATALOG[channel as keyof typeof CHANNEL_PLUGIN_CATALOG];
  return entry
    ? {
        channel,
        pluginId: entry.pluginId,
        installSource: entry.installSource,
      }
    : undefined;
}

export function getChannelPluginCatalogEntryByPluginId(
  pluginId: string,
): ChannelPluginCatalogEntry | undefined {
  const normalizedPluginId = String(pluginId || '').trim();
  for (const channel of Object.keys(CHANNEL_PLUGIN_CATALOG)) {
    const entry = getChannelPluginCatalogEntry(channel as ChannelKind);
    if (entry?.pluginId === normalizedPluginId) return entry;
  }
  return undefined;
}

export function getOfficialChannelPluginCatalogEntries(): OfficialChannelPluginCatalogEntry[] {
  return Object.keys(CHANNEL_PLUGIN_CATALOG).map((channel) => {
    const entry =
      CHANNEL_PLUGIN_CATALOG[channel as keyof typeof CHANNEL_PLUGIN_CATALOG];
    if (!entry) {
      throw new Error(`Invalid channel plugin catalog entry: ${channel}`);
    }
    return { channel: channel as ChannelKind, ...entry };
  });
}

export function getChannelPluginInstallCommand(channel: ChannelKind): string {
  const entry = getChannelPluginCatalogEntry(channel);
  if (!entry) {
    throw new Error(
      `No install-on-demand plugin is registered for ${channel}.`,
    );
  }
  return `hybridclaw plugin install ${entry.installSource}`;
}

export function getChannelPluginStatuses(): ChannelPluginStatus[] {
  return getOfficialChannelPluginCatalogEntries().map((entry) => ({
    channel: entry.channel,
    pluginId: entry.pluginId,
    installSource: entry.installSource,
    transportAvailable: hasChannelTransport(entry.channel),
  }));
}

export interface ChannelPluginAvailabilityChange {
  channel: ChannelKind;
  available: boolean;
}

export type ChannelPluginAvailabilitySnapshot = ReadonlyMap<
  ChannelKind,
  boolean
>;

export function snapshotChannelPluginTransportAvailability(): ChannelPluginAvailabilitySnapshot {
  return new Map(
    Object.keys(CHANNEL_PLUGIN_CATALOG).map((channel) => [
      channel as ChannelKind,
      hasChannelTransport(channel as ChannelKind),
    ]),
  );
}

export function diffChannelPluginTransportAvailability(
  before: ChannelPluginAvailabilitySnapshot,
  after: ChannelPluginAvailabilitySnapshot,
): ChannelPluginAvailabilityChange[] {
  const changes: ChannelPluginAvailabilityChange[] = [];
  for (const [channel, available] of after) {
    if ((before.get(channel) ?? false) !== available) {
      changes.push({ channel, available });
    }
  }
  return changes;
}
