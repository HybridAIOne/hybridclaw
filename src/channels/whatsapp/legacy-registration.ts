/**
 * compat: remove after v0.41 — adapts the released hybridclaw-whatsapp 0.1.x
 * plugin, which registers only `{ kind, create }` and expects auth, pairing,
 * and phone helpers on its host, to the generic channel transport contract.
 *
 * Owns the legacy WhatsApp host extras and the registration hooks that plugin
 * cannot supply yet; delete this directory once the plugin ships them itself.
 * NOT a second transport registry: `channel-transport.ts` calls this once per
 * legacy registration and stores only the adapted result.
 */
import type { RuntimeWhatsAppConfig } from '../../config/runtime-config.js';
import type {
  ChannelTransportAuthStatus,
  ChannelTransportDoctorFinding,
  ChannelTransportHost,
  ChannelTransportInstance,
  ChannelTransportRegistration,
  ChannelTransportSendDescription,
} from '../channel-transport.js';
import {
  acquireWhatsAppAuthLock,
  ensureWhatsAppAuthDir,
  getWhatsAppAuthStatus,
  resetWhatsAppAuthState,
  WHATSAPP_AUTH_DIR,
} from './auth.js';
import {
  clearWhatsAppPairingState,
  getWhatsAppPairingState,
  setWhatsAppPairingError,
  setWhatsAppPairingQrText,
} from './pairing-state.js';
import {
  canonicalizeWhatsAppUserJid,
  isGroupJid,
  isWhatsAppJid,
  jidToPhone,
  normalizePhoneNumber,
  normalizeWhatsAppTarget,
  normalizeWhatsAppUserIdentity,
} from './phone.js';
import { WHATSAPP_SELF_CHAT_ADVISORY } from './self-chat.js';

export interface WhatsAppTransportHost
  extends ChannelTransportHost<RuntimeWhatsAppConfig> {
  auth: {
    authDir: string;
    acquireLock: typeof acquireWhatsAppAuthLock;
    ensureAuthDir: typeof ensureWhatsAppAuthDir;
  };
  pairing: {
    clear: typeof clearWhatsAppPairingState;
    setError: typeof setWhatsAppPairingError;
    setQrText: typeof setWhatsAppPairingQrText;
  };
  phone: {
    canonicalizeUserJid: typeof canonicalizeWhatsAppUserJid;
    isGroupJid: typeof isGroupJid;
    jidToPhone: typeof jidToPhone;
    normalizePhoneNumber: typeof normalizePhoneNumber;
    normalizeUserIdentity: typeof normalizeWhatsAppUserIdentity;
  };
}

interface LegacyWhatsAppRegistration {
  kind: string;
  create(host: WhatsAppTransportHost): ChannelTransportInstance;
}

async function whatsappDoctorChecks({
  enabled,
}: {
  enabled: boolean;
}): Promise<ChannelTransportDoctorFinding[]> {
  const { getConfigSnapshot } = await import('../../config/config.js');
  const config = getConfigSnapshot();
  const auth = await getWhatsAppAuthStatus();
  if (!auth.linked) {
    if (!enabled) return [];
    return [
      {
        severity: config.whatsapp.dmPolicy === 'pairing' ? 'warn' : 'error',
        message: 'WhatsApp not linked',
      },
    ];
  }
  const findings: ChannelTransportDoctorFinding[] = [
    { severity: 'ok', message: 'WhatsApp linked' },
  ];
  if (config.whatsapp.dmPolicy === 'disabled') {
    const { getMostRecentSessionChannelId } = await import(
      '../../memory/db.js'
    );
    const channelId =
      (config.heartbeat?.enabled && config.heartbeat.channel.trim()) ||
      getMostRecentSessionChannelId();
    if (channelId && isWhatsAppJid(channelId) && !isGroupJid(channelId)) {
      findings.push({ severity: 'warn', message: WHATSAPP_SELF_CHAT_ADVISORY });
    }
  }
  return findings;
}

function whatsappMessageToolHints({
  channelId,
}: {
  channelId: string | null;
}): string[] {
  const hints = [
    '- WhatsApp formatting uses `*bold*`, `_italic_`, `~strike~`, and triple-backtick code fences.',
    '- Keep each WhatsApp message chunk concise and under roughly 4,000 characters.',
    '- Avoid Discord-specific syntax like `<@userId>` or `<#channelId>` in WhatsApp replies.',
    '- For `message` sends from WhatsApp, always provide an explicit target when sending to another channel. Use Discord ids/#channel for Discord, a WhatsApp JID/phone number for WhatsApp, or an email address for email.',
  ];
  if (channelId) {
    hints.unshift(
      `- Current WhatsApp chat: \`${channelId}\`. Normal assistant replies go back here automatically; do not reuse this WhatsApp JID as a Discord target.`,
    );
  }
  hints.push(
    channelId && isGroupJid(channelId)
      ? '- Current WhatsApp context is a group chat.'
      : '- Current WhatsApp context is a direct chat.',
  );
  return hints;
}

function describeWhatsAppSend({
  target,
  auth,
}: {
  target: string;
  auth: ChannelTransportAuthStatus;
}): ChannelTransportSendDescription {
  const linkedJid =
    typeof auth.jid === 'string' ? canonicalizeWhatsAppUserJid(auth.jid) : null;
  const isSelfMessage =
    linkedJid != null && linkedJid === canonicalizeWhatsAppUserJid(target);
  return {
    sentFrom: linkedJid
      ? (jidToPhone(linkedJid) ?? linkedJid)
      : 'the linked WhatsApp account',
    recipient: jidToPhone(target) ?? target,
    ...(isSelfMessage
      ? {
          note: 'The recipient is the linked WhatsApp account itself. WhatsApp shows this as a message to yourself and does not send a push notification.',
        }
      : {}),
  };
}

export function adaptLegacyWhatsAppRegistration(
  registration: LegacyWhatsAppRegistration,
): ChannelTransportRegistration {
  return {
    kind: registration.kind,
    create: (host) =>
      registration.create({
        ...(host as ChannelTransportHost<RuntimeWhatsAppConfig>),
        auth: {
          authDir: WHATSAPP_AUTH_DIR,
          acquireLock: acquireWhatsAppAuthLock,
          ensureAuthDir: ensureWhatsAppAuthDir,
        },
        pairing: {
          clear: clearWhatsAppPairingState,
          setError: setWhatsAppPairingError,
          setQrText: setWhatsAppPairingQrText,
        },
        phone: {
          canonicalizeUserJid: canonicalizeWhatsAppUserJid,
          isGroupJid,
          jidToPhone,
          normalizePhoneNumber,
          normalizeUserIdentity: normalizeWhatsAppUserIdentity,
        },
      }),
    matchesTarget: isWhatsAppJid,
    normalizeTarget: normalizeWhatsAppTarget,
    getAuthStatus: () => getWhatsAppAuthStatus(),
    resetAuth: () => resetWhatsAppAuthState(),
    getPairingState: () => ({ ...getWhatsAppPairingState() }),
    doctorChecks: whatsappDoctorChecks,
    messageToolHints: whatsappMessageToolHints,
    describeSend: describeWhatsAppSend,
  };
}
