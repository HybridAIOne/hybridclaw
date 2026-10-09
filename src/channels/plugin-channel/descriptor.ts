/**
 * Channel descriptors for catalog plugin channels, derived from the catalog
 * and the transport registry instead of one hand-written file per kind.
 *
 * The registered plugin decides which targets are its own; without it, the
 * catalog's stored-id pattern keeps released session ids classified so they
 * fail with the install hint instead of reaching another channel.
 * Classifying a target never loads the runtime.
 */
import type { ChannelDescriptor } from '../channel-descriptor.js';
import {
  getPluginChannelCoreFacts,
  PLUGIN_CHANNEL_KINDS,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import { getChannelTransport } from '../channel-transport.js';

let runtimeModule: Promise<typeof import('./runtime.js')> | null = null;
const loadRuntime = () => (runtimeModule ??= import('./runtime.js'));

function createPluginChannelDescriptor(
  kind: PluginChannelKind,
): ChannelDescriptor {
  return {
    kind,
    matchesTarget: (target) =>
      getChannelTransport(kind)?.matchesTarget(target) ??
      getPluginChannelCoreFacts(kind).isStoredTarget(target),
    supportsProactive: true,
    sendProactive: async (...args) =>
      (await import('./proactive.js')).sendPluginChannelProactive(
        kind,
        ...args,
      ),
    start: async () =>
      (await import('./gateway.js')).startPluginChannelIntegration(kind),
    stop: async () => (await loadRuntime()).shutdownPluginChannel(kind),
    configChanged: getPluginChannelCoreFacts(kind).configChanged,
  };
}

export const PLUGIN_CHANNEL_DESCRIPTORS = Object.fromEntries(
  PLUGIN_CHANNEL_KINDS.map((kind) => [
    kind,
    createPluginChannelDescriptor(kind),
  ]),
) as Record<PluginChannelKind, ChannelDescriptor>;
