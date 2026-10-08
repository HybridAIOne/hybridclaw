/**
 * Channel transport registry — the only path from core to a plugin-backed
 * channel. A registration carries the transport factory plus what core asks
 * without starting it: target matching, linked-account state, the live pairing
 * prompt, doctor findings, and prompt hints.
 *
 * Kinds come from the official channel plugin catalog; registering or
 * resolving any other kind throws instead of falling back. NOT the channel
 * runtime (`plugin-channel/runtime.ts` owns live instances) and NOT a delivery
 * receipt: send results only carry the transport's message IDs.
 */
import type { PluginLogger } from '../plugins/plugin-types.js';
import type { MediaContextItem } from '../types/container.js';
import type { ChannelKind } from './channel.js';
import {
  getChannelPluginCatalogEntry,
  getChannelPluginInstallCommand,
  getOfficialChannelPluginCatalogEntries,
  getPluginChannelName,
  isPluginChannelKind,
  PLUGIN_CHANNEL_KINDS,
  type PluginChannelKind,
} from './channel-plugin-catalog.js';
import { adaptLegacyWhatsAppRegistration } from './whatsapp/legacy-registration.js';

export type ChannelTransportReplyFn = (content: string) => Promise<void>;

export interface ChannelTransportMessageContext {
  abortSignal: AbortSignal;
  batchedMessages: unknown[];
  rawMessage: unknown;
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
}

export type ChannelTransportMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: ChannelTransportReplyFn,
  context: ChannelTransportMessageContext,
) => Promise<void>;

export interface ChannelTransportMediaSendParams {
  jid: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
}

export interface ChannelTransportPairingSession {
  start(): Promise<void>;
  waitForConnection(): Promise<{ id: string | null }>;
  stop(): Promise<void>;
}

export interface ChannelTransportSendResult {
  messageIds: string[];
}

export interface ChannelTransportInstance {
  /** Rejects with an error carrying `lockPath` when another process owns the credentials. */
  init(handler: ChannelTransportMessageHandler): Promise<void>;
  shutdown(): Promise<void>;
  sendText(
    chatId: string,
    text: string,
  ): Promise<ChannelTransportSendResult> | Promise<void>;
  sendMedia(
    params: ChannelTransportMediaSendParams,
  ): Promise<ChannelTransportSendResult> | Promise<void>;
  createPairingSession?(): Promise<ChannelTransportPairingSession>;
}

/** Core services a transport uses; plugin runtime code never imports core. */
export interface ChannelTransportHost<Config = unknown> {
  appVersion: string;
  defaultAgentId: string;
  logger: PluginLogger;
  /** The live `config.<kind>` section, re-read on every call. */
  getConfig(): Config;
  media: {
    createContextItem(params: {
      attachmentName: string;
      buffer: Buffer;
      mimeType?: string | null;
      sizeBytes?: number;
      originalUrl?: string | null;
    }): Promise<MediaContextItem>;
    normalizeMimeType(value: string | null | undefined): string | null;
    resolveManagedTempDir(params: { filePath: string }): string | null;
  };
  text: {
    chunkMessage(
      text: string,
      options: { maxChars: number; maxLines?: number },
    ): string[];
    normalizeNativeAgentAddressingText(text: string): string;
  };
  buildSessionKey(
    agentId: string,
    channelKind: string,
    chatType: string,
    peerId: string,
  ): string;
  describeExpectedTransportError(
    error: unknown,
    subject: string,
    fallbackHost?: string | null,
  ): string;
  isExpectedTransportError(error: unknown): boolean;
  SlidingWindowRateLimiter: new (
    windowMs?: number,
  ) => {
    check(
      key: string,
      limit: number,
      nowMs?: number,
    ): { allowed: boolean; remaining: number; retryAfterMs: number };
    shouldNotify(key: string, cooldownMs?: number, nowMs?: number): boolean;
  };
  sleep(ms: number): Promise<void>;
  renderQrSvg(input: string, ariaLabel?: string): string;
}

/** `linked` plus the account fields gateway status publishes (`jid`, `mid`). */
export interface ChannelTransportAuthStatus {
  linked: boolean;
  [field: string]: unknown;
}

/** The pairing prompt the admin console shows; extra fields pass through. */
export interface ChannelTransportPairingState {
  pairingQrText: string | null;
  updatedAt: string | null;
  error: string | null;
  [field: string]: unknown;
}

export interface ChannelTransportDoctorFinding {
  severity: 'ok' | 'warn' | 'error';
  message: string;
}

/** How a message-tool send names the sending account and the recipient. */
export interface ChannelTransportSendDescription {
  sentFrom: string;
  recipient: string;
  note?: string;
}

export interface ChannelTransportRegistration {
  kind: string;
  create(host: ChannelTransportHost): ChannelTransportInstance;
  /** Claims a canonical channel id (session, proactive, and scheduler targets). */
  matchesTarget(target: string): boolean;
  /**
   * Canonicalizes a message-tool target. Returns null when the target is not
   * this channel's; throws when it uses this channel's prefix but is malformed.
   */
  normalizeTarget(target: string): string | null;
  getAuthStatus(): Promise<ChannelTransportAuthStatus>;
  /** Clears the linked account and returns the credential directory it reset. */
  resetAuth(): Promise<string>;
  getPairingState?(): ChannelTransportPairingState;
  /** `enabled` is the channel's config switch; the plugin may be loaded while off. */
  doctorChecks?(params: {
    enabled: boolean;
  }): Promise<ChannelTransportDoctorFinding[]>;
  messageToolHints?(params: { channelId: string | null }): string[];
  describeSend?(params: {
    target: string;
    auth: ChannelTransportAuthStatus;
  }): ChannelTransportSendDescription;
}

export class ChannelTransportMissingError extends Error {
  constructor(kind: PluginChannelKind) {
    super(
      `${getPluginChannelName(kind)} transport plugin is not installed. Install it with: ${getChannelPluginInstallCommand(kind)}`,
    );
    this.name = 'ChannelTransportMissingError';
  }
}

const transports = new Map<string, ChannelTransportRegistration>();

function requirePluginChannelKind(kind: string): PluginChannelKind {
  if (!isPluginChannelKind(kind)) {
    throw new Error(
      `Unknown channel transport kind "${kind}". Only catalog channel plugins register transports.`,
    );
  }
  return kind;
}

const REQUIRED_REGISTRATION_MEMBERS = [
  'create',
  'matchesTarget',
  'normalizeTarget',
  'getAuthStatus',
  'resetAuth',
] as const;

function normalizeRegistration(
  registration: ChannelTransportRegistration,
): ChannelTransportRegistration {
  if (typeof registration.matchesTarget === 'function') {
    const missing = REQUIRED_REGISTRATION_MEMBERS.filter(
      (member) => typeof registration[member] !== 'function',
    );
    if (missing.length > 0) {
      throw new Error(
        `Channel transport "${registration.kind}" is missing ${missing.join(', ')}.`,
      );
    }
    return registration;
  }
  // compat: remove after v0.41 — hybridclaw-whatsapp 0.1.x registers only
  // `{ kind, create }` against the retired WhatsApp host.
  if (registration.kind === 'whatsapp') {
    return adaptLegacyWhatsAppRegistration(registration);
  }
  const kind = requirePluginChannelKind(registration.kind);
  throw new Error(
    `Channel transport "${kind}" uses the retired create-only contract. Update the plugin: hybridclaw plugin reinstall ${getChannelPluginCatalogEntry(kind)?.installSource}`,
  );
}

export function registerChannelTransport(
  registration: ChannelTransportRegistration,
): ChannelTransportRegistration {
  requirePluginChannelKind(registration.kind);
  if (transports.has(registration.kind)) {
    throw new Error(
      `Channel transport "${registration.kind}" is already registered.`,
    );
  }
  const normalized = normalizeRegistration(registration);
  transports.set(registration.kind, normalized);
  return normalized;
}

export function unregisterChannelTransport(kind: string): void {
  transports.delete(kind);
}

export function hasChannelTransport(kind: string): boolean {
  return transports.has(kind);
}

export function getChannelTransport(
  kind: string,
): ChannelTransportRegistration | undefined {
  requirePluginChannelKind(kind);
  return transports.get(kind);
}

export function requireChannelTransport(
  kind: string,
): ChannelTransportRegistration {
  const pluginKind = requirePluginChannelKind(kind);
  const registration = transports.get(pluginKind);
  if (!registration) throw new ChannelTransportMissingError(pluginKind);
  return registration;
}

export interface ChannelPluginStatus {
  channel: ChannelKind;
  pluginId: string;
  installSource: string;
  transportAvailable: boolean;
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
    PLUGIN_CHANNEL_KINDS.map((channel) => [
      channel,
      hasChannelTransport(channel),
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
