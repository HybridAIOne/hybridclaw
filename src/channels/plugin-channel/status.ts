/**
 * Gateway-status and doctor views of catalog plugin channels, read from the
 * transport registry so core never inspects a plugin's credential files.
 *
 * A channel whose plugin is not loaded reports `linked: false`; an enabled
 * channel without its plugin is a doctor error. NOT a liveness probe: nothing
 * here starts or contacts a transport.
 */
import type { RuntimeConfig } from '../../config/runtime-config.js';
import {
  getPluginChannelCoreFacts,
  getPluginChannelName,
  PLUGIN_CHANNEL_KINDS,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import {
  type ChannelTransportDoctorFinding,
  getChannelTransport,
} from '../channel-transport.js';

export interface PluginChannelGatewayStatus {
  enabled: boolean;
  linked: boolean;
  pairingQrText: string | null;
  pairingUpdatedAt: string | null;
  pairingError: string | null;
  [field: string]: unknown;
}

async function getPluginChannelStatus(
  kind: PluginChannelKind,
  config: RuntimeConfig,
): Promise<PluginChannelGatewayStatus> {
  const registration = getChannelTransport(kind);
  const auth = (await registration?.getAuthStatus().catch(() => null)) ?? {
    linked: false,
  };
  const {
    updatedAt,
    error,
    pairingQrText = null,
    ...pairingFields
  } = registration?.getPairingState?.() ?? {
    pairingQrText: null,
    updatedAt: null,
    error: null,
  };
  return {
    ...auth,
    ...pairingFields,
    enabled: getPluginChannelCoreFacts(kind).isEnabled(config),
    linked: auth.linked,
    pairingQrText,
    pairingUpdatedAt: updatedAt,
    pairingError: error,
  };
}

export async function getPluginChannelGatewayStatuses(
  config: RuntimeConfig,
): Promise<Record<PluginChannelKind, PluginChannelGatewayStatus>> {
  return Object.fromEntries(
    await Promise.all(
      PLUGIN_CHANNEL_KINDS.map(
        async (kind) =>
          [kind, await getPluginChannelStatus(kind, config)] as const,
      ),
    ),
  ) as Record<PluginChannelKind, PluginChannelGatewayStatus>;
}

export async function checkPluginChannels(
  config: RuntimeConfig,
): Promise<ChannelTransportDoctorFinding[]> {
  const enabledKinds = new Set(
    PLUGIN_CHANNEL_KINDS.filter((kind) =>
      getPluginChannelCoreFacts(kind).isEnabled(config),
    ),
  );
  // Plugin init starts plugin services, so doctor only pays for it when a
  // plugin channel is switched on; otherwise it reports what is already loaded.
  if (enabledKinds.size > 0) {
    const { ensurePluginManagerInitialized } = await import(
      '../../plugins/plugin-manager.js'
    );
    await ensurePluginManagerInitialized().catch(() => undefined);
  }
  const findings: ChannelTransportDoctorFinding[] = [];
  for (const kind of PLUGIN_CHANNEL_KINDS) {
    const enabled = enabledKinds.has(kind);
    const registration = getChannelTransport(kind);
    if (!registration) {
      if (enabled) {
        findings.push({
          severity: 'error',
          message: `${getPluginChannelName(kind)} plugin not installed`,
        });
      }
      continue;
    }
    findings.push(...((await registration.doctorChecks?.({ enabled })) ?? []));
  }
  return findings;
}
