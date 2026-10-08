/**
 * Official channel-plugin catalog — the source of truth for install-on-demand
 * transports. Entries are curated code provenance plus the core-owned config
 * facts (enablement, restart triggers) a channel needs while its plugin is
 * absent; they say nothing about runtime availability.
 */
import type { RuntimeConfig } from '../config/runtime-config.js';
import { equalStringSets } from '../utils/string-list-equality.js';
import type { ChannelKind } from './channel.js';

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
      'https://github.com/HybridAIOne/hybridclaw-whatsapp/releases/download/v0.1.1/hybridaione-hybridclaw-whatsapp-0.1.1.tgz',
  },
} as const satisfies Partial<
  Record<ChannelKind, Omit<OfficialChannelPluginCatalogEntry, 'channel'>>
>;

export type PluginChannelKind = keyof typeof CHANNEL_PLUGIN_CATALOG;

export interface PluginChannelCoreFacts {
  isEnabled(config: RuntimeConfig): boolean;
  configChanged(next: RuntimeConfig, prev: RuntimeConfig): boolean;
  /** Channel ids that sessions and schedules already store for this channel. */
  storedTargets: RegExp;
}

// The `whatsapp` and `line` config sections and the channel ids stored in
// sessions are released data, so core keeps these facts while the plugin is
// absent. `storedTargets` only keeps such ids classified (failing with the
// install hint) instead of falling through to email (decided 2026-10-08 in the
// #1801 transport registration change); a loaded plugin's `matchesTarget`
// decides whenever it is registered.
const PLUGIN_CHANNEL_CORE_FACTS: Record<
  PluginChannelKind,
  PluginChannelCoreFacts
> = {
  line: {
    storedTargets: /^line:/i,
    isEnabled: (config) => config.line.enabled,
    configChanged: (next, prev) =>
      next.line.enabled !== prev.line.enabled ||
      next.line.textChunkLimit !== prev.line.textChunkLimit,
  },
  whatsapp: {
    storedTargets:
      /^(?:whatsapp:)?[\d:-]+@(?:s\.whatsapp\.net|g\.us|lid|hosted|hosted\.lid)$/i,
    isEnabled: (config) =>
      config.whatsapp.dmPolicy !== 'disabled' ||
      config.whatsapp.groupPolicy !== 'disabled',
    configChanged: ({ whatsapp: next }, { whatsapp: prev }) =>
      next.dmPolicy !== prev.dmPolicy ||
      next.groupPolicy !== prev.groupPolicy ||
      !equalStringSets(next.allowFrom, prev.allowFrom) ||
      !equalStringSets(next.groupAllowFrom, prev.groupAllowFrom) ||
      next.debounceMs !== prev.debounceMs ||
      next.ackReaction !== prev.ackReaction ||
      next.textChunkLimit !== prev.textChunkLimit ||
      next.mediaMaxMb !== prev.mediaMaxMb ||
      next.sendReadReceipts !== prev.sendReadReceipts,
  },
};

export const PLUGIN_CHANNEL_KINDS = Object.keys(
  CHANNEL_PLUGIN_CATALOG,
) as PluginChannelKind[];

export function isPluginChannelKind(kind: string): kind is PluginChannelKind {
  return Object.hasOwn(CHANNEL_PLUGIN_CATALOG, kind);
}

export function getPluginChannelCoreFacts(
  kind: PluginChannelKind,
): PluginChannelCoreFacts {
  return PLUGIN_CHANNEL_CORE_FACTS[kind];
}

export function getPluginChannelName(kind: PluginChannelKind): string {
  return CHANNEL_PLUGIN_CATALOG[kind].name;
}

export function getChannelPluginCatalogEntry(
  channel: ChannelKind,
): ChannelPluginCatalogEntry | undefined {
  const entry = isPluginChannelKind(channel)
    ? CHANNEL_PLUGIN_CATALOG[channel]
    : undefined;
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
