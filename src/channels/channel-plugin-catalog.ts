import type { ChannelKind } from './channel.js';
import { hasChannelTransport } from './channel-transport.js';

export interface ChannelPluginCatalogEntry {
  channel: ChannelKind;
  pluginId: string;
  installSource: string;
}

export interface ChannelPluginStatus extends ChannelPluginCatalogEntry {
  transportAvailable: boolean;
}

const CHANNEL_PLUGIN_CATALOG = {
  whatsapp: {
    pluginId: 'whatsapp',
    installSource: '@hybridaione/hybridclaw-whatsapp',
  },
} as const satisfies Partial<
  Record<ChannelKind, Omit<ChannelPluginCatalogEntry, 'channel'>>
>;

export function getChannelPluginCatalogEntry(
  channel: ChannelKind,
): ChannelPluginCatalogEntry | undefined {
  const entry: Omit<ChannelPluginCatalogEntry, 'channel'> | undefined =
    CHANNEL_PLUGIN_CATALOG[channel as keyof typeof CHANNEL_PLUGIN_CATALOG];
  return entry ? { channel, ...entry } : undefined;
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
  return Object.keys(CHANNEL_PLUGIN_CATALOG).map((channel) => {
    const entry = getChannelPluginCatalogEntry(channel as ChannelKind);
    if (!entry)
      throw new Error(`Invalid channel plugin catalog entry: ${channel}`);
    return {
      ...entry,
      transportAvailable: hasChannelTransport(entry.channel),
    };
  });
}
