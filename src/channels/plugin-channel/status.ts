/**
 * Gateway-status and doctor views of catalog plugin channels, read from the
 * transport registry so core never inspects a plugin's credential files.
 *
 * A channel whose plugin is not loaded reports `linked: false`, and each kind
 * is read independently, so one plugin's failing hook never hides another
 * channel. An enabled channel without its plugin is a doctor error. NOT a
 * liveness probe: nothing here starts or contacts a transport.
 */
import fs from 'node:fs';
import { DB_PATH } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/runtime-config.js';
import {
  getPluginChannelCoreFacts,
  PLUGIN_CHANNEL_KINDS,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import {
  type ChannelTransportAuthStatus,
  type ChannelTransportDoctorFinding,
  type ChannelTransportPairingState,
  describeMissingChannelTransport,
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

const UNLINKED: ChannelTransportAuthStatus = { linked: false };
const NO_PAIRING: ChannelTransportPairingState = {
  pairingQrText: null,
  updatedAt: null,
  error: null,
};

async function getPluginChannelStatus(
  kind: PluginChannelKind,
  config: RuntimeConfig,
): Promise<PluginChannelGatewayStatus> {
  const registration = getChannelTransport(kind);
  let auth = UNLINKED;
  let pairing = NO_PAIRING;
  try {
    auth = (await registration?.getAuthStatus()) ?? UNLINKED;
  } catch {}
  try {
    pairing = registration?.getPairingState?.() ?? NO_PAIRING;
  } catch {}
  const { updatedAt, error, pairingQrText = null, ...pairingFields } = pairing;
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

/** The heartbeat target, else the most recent session's channel id. */
async function getStoredDeliveryTarget(
  config: RuntimeConfig,
): Promise<string | null> {
  const heartbeat =
    config.heartbeat?.enabled && config.heartbeat.channel.trim();
  if (heartbeat) return heartbeat;
  // Doctor reports a missing database itself; reading here must not create one.
  if (!fs.existsSync(DB_PATH)) return null;
  const { getMostRecentSessionChannelId } = await import('../../memory/db.js');
  return getMostRecentSessionChannelId();
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
  // plugin channel is switched on or is where scheduled output goes (an
  // outbound-only WhatsApp self-chat has both policies disabled).
  const storedTarget = await getStoredDeliveryTarget(config);
  const storedTargetKind = storedTarget
    ? PLUGIN_CHANNEL_KINDS.find((kind) =>
        getPluginChannelCoreFacts(kind).isStoredTarget(storedTarget),
      )
    : undefined;
  if (enabledKinds.size > 0 || storedTargetKind) {
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
      if (enabled || kind === storedTargetKind) {
        findings.push({
          severity: enabled ? 'error' : 'warn',
          message: describeMissingChannelTransport(kind),
        });
      }
      continue;
    }
    findings.push(...((await registration.doctorChecks?.({ enabled })) ?? []));
  }
  return findings;
}
