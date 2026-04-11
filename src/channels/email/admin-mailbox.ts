import {
  type FetchMessageObject,
  ImapFlow,
  type MessageAddressObject,
  type MessageStructureObject,
} from 'imapflow';
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { SILENT_REPLY_TOKEN } from '../../agent/silent-reply.js';
import type { RuntimeEmailConfig } from '../../config/runtime-config.js';
import {
  getRecentMessages,
  getRecentSessionUsageEvents,
  getRecentStructuredAuditForSession,
  getSessionById,
  getSessionsByChannelId,
  searchStructuredAudit,
} from '../../memory/db.js';
import { resolveModelProvider } from '../../providers/factory.js';
import type { StructuredAuditEntry } from '../../types/audit.js';
import type { Session, StoredMessage } from '../../types/session.js';
import { normalizeEmailAddress } from './allowlist.js';
import { DEFAULT_EMAIL_SUBJECT } from './constants.js';
import {
  isTrashFolderCandidate,
  listSelectableFolders,
  resolveTrashFolderPath,
} from './mailbox-folders.js';
import {
  type EmailDeliveryMetadata,
  parseEmailDeliveryMetadata,
} from './metadata.js';

const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_MESSAGE_LIMIT = 100;
const PREVIEW_MAX_LENGTH = 220;
const PREVIEW_MAX_BYTES = 12_000;
const METADATA_FALLBACK_WINDOW_MS = 15 * 60 * 1000;
const METADATA_FALLBACK_MESSAGE_LIMIT = 200;
const METADATA_FALLBACK_USAGE_LIMIT = 50;
const SYNTHETIC_THREAD_UID_OFFSET = 1_000_000_000;
const SYNTHETIC_SENT_FOLDER_UID_OFFSET = 2_000_000_000;
const SYNTHETIC_AUDIT_LIMIT = 100;
const SYNTHETIC_SENT_FOLDER_AUDIT_LIMIT = 500;
const SYNTHETIC_IMAP_MATCH_WINDOW_MS = 5 * 60 * 1000;
const SYNTHETIC_RECIPIENT_INFERENCE_WINDOW_MS = 60 * 60 * 1000;
const SYNTHETIC_SUBJECT_RE = /^\[subject:\s*([^\]\n]+)\]\s*(?:\n+)?/i;
const EMAIL_ADDRESS_CANDIDATE_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface LiveAdminEmailFolder {
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unseen: number;
}

export interface LiveAdminEmailMessageSummary {
  folder: string;
  uid: number;
  messageId: string | null;
  subject: string;
  fromAddress: string | null;
  fromName: string | null;
  preview: string | null;
  receivedAt: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
}

export interface LiveAdminEmailParticipant {
  name: string | null;
  address: string | null;
}

export interface LiveAdminEmailAttachment {
  filename: string | null;
  contentType: string | null;
  size: number | null;
}

export interface LiveAdminEmailMessageMetadata extends EmailDeliveryMetadata {}

export interface LiveAdminEmailMessageDetail
  extends LiveAdminEmailMessageSummary {
  to: LiveAdminEmailParticipant[];
  cc: LiveAdminEmailParticipant[];
  bcc: LiveAdminEmailParticipant[];
  replyTo: LiveAdminEmailParticipant[];
  text: string | null;
  attachments: LiveAdminEmailAttachment[];
  metadata: LiveAdminEmailMessageMetadata | null;
}

export interface LiveAdminEmailMessageThreadSnapshot {
  message: LiveAdminEmailMessageDetail | null;
  thread: LiveAdminEmailMessageDetail[];
}

export interface LiveAdminEmailMailboxSnapshot {
  address: string;
  folders: LiveAdminEmailFolder[];
  defaultFolder: string | null;
}

export interface LiveAdminEmailFolderSnapshot {
  folder: string;
  messages: LiveAdminEmailMessageSummary[];
}

export interface LiveAdminEmailDeleteResult {
  deleted: true;
  targetFolder: string | null;
  permanent: boolean;
}

function resolveConfiguredFolders(folders: string[]): string[] {
  const resolved = folders
    .map((folder) => String(folder || '').trim())
    .filter(Boolean);
  return resolved.length > 0 ? [...new Set(resolved)] : ['INBOX'];
}

function normalizeFolderPath(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function createImapClient(
  config: RuntimeEmailConfig,
  password: string,
): ImapFlow {
  return new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.address,
      pass: password,
    },
    disableAutoIdle: true,
    logger: false,
  });
}

async function withLiveEmailClient<T>(
  config: RuntimeEmailConfig,
  password: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient(config, password);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {
      client.close();
    });
  }
}

function folderSortRank(
  folder: Pick<LiveAdminEmailFolder, 'path' | 'specialUse'>,
  configured: Set<string>,
): number {
  if (folder.specialUse === '\\Inbox') return 0;
  if (configured.has(folder.path)) return 1;
  if (folder.specialUse === '\\Flagged') return 2;
  if (folder.specialUse === '\\Sent') return 3;
  if (folder.specialUse === '\\Drafts') return 4;
  if (folder.specialUse === '\\Archive') return 5;
  if (folder.specialUse === '\\Junk') return 6;
  if (folder.specialUse === '\\Trash') return 7;
  return 10;
}

function buildFallbackFolder(path: string): LiveAdminEmailFolder {
  const trimmed = String(path || '').trim();
  return {
    path: trimmed,
    name: trimmed,
    specialUse: trimmed.toUpperCase() === 'INBOX' ? '\\Inbox' : null,
    total: 0,
    unseen: 0,
  };
}

function normalizeFolderSummary(entry: {
  path: string;
  name?: string;
  specialUse?: string;
  status?: {
    messages?: number;
    unseen?: number;
  };
}): LiveAdminEmailFolder {
  return {
    path: entry.path,
    name: String(entry.name || entry.path).trim() || entry.path,
    specialUse: entry.specialUse || null,
    total: Math.max(0, Number(entry.status?.messages || 0)),
    unseen: Math.max(0, Number(entry.status?.unseen || 0)),
  };
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed =
    value instanceof Date ? value : new Date(String(value || '').trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseTimestampMs(value: string | null | undefined): number {
  const normalized = String(value || '').trim();
  if (!normalized) return 0;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    const parsed = Date.parse(`${normalized.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function hasFlag(
  flags: Set<string> | undefined,
  expected: '\\Seen' | '\\Answered' | '\\Flagged',
): boolean {
  if (!flags) return false;
  for (const flag of flags) {
    if (String(flag || '').toLowerCase() === expected.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function trimText(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeComparableEmailAddress(
  value: string | null | undefined,
): string | null {
  const trimmed = trimText(value);
  if (!trimmed) return null;
  return normalizeEmailAddress(trimmed) || trimmed.toLowerCase();
}

function isSameEmailAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeComparableEmailAddress(left);
  const normalizedRight = normalizeComparableEmailAddress(right);
  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
  );
}

function normalizeMessageIdList(
  value: string | string[] | null | undefined,
): string[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((entry) => trimText(entry))
          .filter((entry): entry is string => entry !== null),
      ),
    ];
  }
  const single = trimText(value);
  return single ? [single] : [];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizeComparableText(value: string | null | undefined): string {
  return collapseWhitespace(String(value || '')).toLowerCase();
}

function extractSubjectAndBody(value: string): {
  subject: string | null;
  body: string;
} {
  const normalized = String(value || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(SYNTHETIC_SUBJECT_RE);
  if (!match?.[1]) {
    return {
      subject: null,
      body: normalized.trim(),
    };
  }
  return {
    subject: trimText(match[1]),
    body: normalized.slice(match[0].length).trim(),
  };
}

function summarizeTextPreview(value: string | null | undefined): string | null {
  const normalized = collapseWhitespace(String(value || ''));
  if (!normalized) return null;
  if (normalized.length <= PREVIEW_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function extractTextFromHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  });
}

function normalizeBodyText(mail: ParsedMail): string | null {
  const text = trimText(String(mail.text || '').replace(/\r\n?/g, '\n'));
  if (text) return text;

  const html = trimText(typeof mail.html === 'string' ? mail.html : '');
  if (!html) return null;
  return trimText(extractTextFromHtml(html).replace(/\r\n?/g, '\n'));
}

function mapEnvelopeAddress(
  entry: MessageAddressObject | undefined,
): LiveAdminEmailParticipant {
  const rawAddress = trimText(entry?.address || null);
  return {
    name: trimText(entry?.name || null),
    address: normalizeEmailAddress(rawAddress || '') || rawAddress,
  };
}

function mapEnvelopeSender(
  message: FetchMessageObject,
): LiveAdminEmailParticipant {
  return mapEnvelopeAddress(message.envelope?.from?.[0]);
}

function mapParsedAddresses(
  entries: AddressObject | AddressObject[] | null | undefined,
): LiveAdminEmailParticipant[] {
  const flattened = Array.isArray(entries)
    ? entries.flatMap((entry) => entry.value || [])
    : entries?.value || [];
  return flattened
    .map((entry) => {
      const rawAddress = trimText(entry.address || null);
      return {
        name: trimText(entry.name || null),
        address: normalizeEmailAddress(rawAddress || '') || rawAddress,
      };
    })
    .filter((entry) => entry.address || entry.name);
}

interface SessionMetadataLookupContext {
  session: Session;
  recentMessages: StoredMessage[];
  assistantMessages: StoredMessage[];
  usageEvents: ReturnType<typeof getRecentSessionUsageEvents>;
  structuredAudit: StructuredAuditEntry[];
}

function resolveFallbackSessionForMessage(
  message: LiveAdminEmailMessageDetail,
  selfAddress: string,
): Session | null {
  const fromAddress = normalizeComparableEmailAddress(message.fromAddress);
  const targetAddress =
    fromAddress && !isSameEmailAddress(fromAddress, selfAddress)
      ? fromAddress
      : message.to
          .map((entry) => normalizeComparableEmailAddress(entry.address))
          .find(
            (address) => address && !isSameEmailAddress(address, selfAddress),
          ) ||
        message.cc
          .map((entry) => normalizeComparableEmailAddress(entry.address))
          .find(
            (address) => address && !isSameEmailAddress(address, selfAddress),
          ) ||
        message.bcc
          .map((entry) => normalizeComparableEmailAddress(entry.address))
          .find(
            (address) => address && !isSameEmailAddress(address, selfAddress),
          ) ||
        null;
  if (!targetAddress) return null;

  const sessions = getSessionsByChannelId(targetAddress);
  if (sessions.length === 0) {
    return null;
  }

  const messageTimestamp = parseTimestampMs(message.receivedAt);
  if (messageTimestamp <= 0) {
    return sessions[0] || null;
  }

  return (
    [...sessions].sort((left, right) => {
      const leftCreated = parseTimestampMs(left.created_at);
      const rightCreated = parseTimestampMs(right.created_at);
      const leftDistance = Math.abs(leftCreated - messageTimestamp);
      const rightDistance = Math.abs(rightCreated - messageTimestamp);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      if (rightCreated !== leftCreated) {
        return rightCreated - leftCreated;
      }
      return right.id.localeCompare(left.id);
    })[0] || null
  );
}

function loadSessionMetadataLookupContext(
  session: Session,
  cache: Map<string, SessionMetadataLookupContext>,
): SessionMetadataLookupContext {
  const cached = cache.get(session.id);
  if (cached) return cached;

  const recentMessages = getRecentMessages(
    session.id,
    METADATA_FALLBACK_MESSAGE_LIMIT,
  );
  const context: SessionMetadataLookupContext = {
    session,
    recentMessages,
    assistantMessages: recentMessages.filter(
      (entry) => entry.role === 'assistant',
    ),
    usageEvents: getRecentSessionUsageEvents(
      session.id,
      METADATA_FALLBACK_USAGE_LIMIT,
    ),
    structuredAudit: getRecentStructuredAuditForSession(
      session.id,
      SYNTHETIC_AUDIT_LIMIT,
    ),
  };
  cache.set(session.id, context);
  return context;
}

function buildSyntheticSentAuditUid(auditEntryId: number): number {
  return -(SYNTHETIC_SENT_FOLDER_UID_OFFSET + Math.max(0, auditEntryId));
}

function isSentFolderName(value: string | null | undefined): boolean {
  const normalized = normalizeFolderPath(value);
  return normalized === 'sent' || normalized.includes('sent');
}

async function isSentFolderPath(
  client: ImapFlow,
  folder: string,
): Promise<boolean> {
  const normalizedFolder = normalizeFolderPath(folder);
  if (isSentFolderName(normalizedFolder)) {
    return true;
  }

  const folders = await listSelectableFolders(client);
  return folders.some(
    (entry) =>
      normalizeFolderPath(entry.path) === normalizedFolder &&
      String(entry.specialUse || '').toLowerCase() === '\\sent',
  );
}

function parseSyntheticRecipientValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.flatMap((entry) =>
    String(entry ?? '')
      .split(/[,\n;]+/)
      .map((candidate) => normalizeEmailAddress(candidate)),
  );
  return [
    ...new Set(normalized.filter((entry): entry is string => Boolean(entry))),
  ];
}

function toParticipants(addresses: string[]): LiveAdminEmailParticipant[] {
  return addresses.map((address) => ({ name: null, address }));
}

function extractEmailAddresses(value: string | null | undefined): string[] {
  const matches = String(value || '').match(EMAIL_ADDRESS_CANDIDATE_RE) || [];
  return [
    ...new Set(
      matches
        .map((candidate) => normalizeEmailAddress(candidate))
        .filter((candidate): candidate is string => Boolean(candidate)),
    ),
  ];
}

function inferRecipientsFromPrompt(content: string): {
  to: string[];
  cc: string[];
  bcc: string[];
} {
  const normalized = String(content || '').replace(/\r\n?/g, '\n');
  const readLabeled = (label: 'to' | 'cc' | 'bcc'): string[] => {
    const values: string[] = [];
    const pattern = new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*(.+)$`, 'gim');
    for (const match of normalized.matchAll(pattern)) {
      values.push(...extractEmailAddresses(match[1] || ''));
    }
    return [...new Set(values)];
  };

  const cc = readLabeled('cc');
  const bcc = readLabeled('bcc');
  const labeledTo = readLabeled('to');
  const unlabeled = extractEmailAddresses(normalized).filter(
    (address) => !cc.includes(address) && !bcc.includes(address),
  );

  return {
    to: labeledTo.length > 0 ? labeledTo : unlabeled,
    cc,
    bcc,
  };
}

function inferRecipientsFromSessionContext(params: {
  context: SessionMetadataLookupContext;
  timestampMs: number;
}): {
  to: string[];
  cc: string[];
  bcc: string[];
} {
  const candidates = params.context.recentMessages
    .filter((entry) => entry.role === 'user')
    .map((entry) => ({
      entry,
      timestampMs: parseTimestampMs(entry.created_at),
    }))
    .filter(
      ({ timestampMs }) =>
        timestampMs > 0 &&
        Math.abs(timestampMs - params.timestampMs) <=
          SYNTHETIC_RECIPIENT_INFERENCE_WINDOW_MS,
    )
    .sort((left, right) => {
      const leftAfter = left.timestampMs > params.timestampMs ? 1 : 0;
      const rightAfter = right.timestampMs > params.timestampMs ? 1 : 0;
      if (leftAfter !== rightAfter) return leftAfter - rightAfter;
      const distance =
        Math.abs(left.timestampMs - params.timestampMs) -
        Math.abs(right.timestampMs - params.timestampMs);
      if (distance !== 0) return distance;
      return right.timestampMs - left.timestampMs;
    });

  for (const candidate of candidates) {
    const recipients = inferRecipientsFromPrompt(candidate.entry.content);
    if (
      recipients.to.length > 0 ||
      recipients.cc.length > 0 ||
      recipients.bcc.length > 0
    ) {
      return recipients;
    }
  }

  return {
    to: [],
    cc: [],
    bcc: [],
  };
}

function toMessageSummary(
  message: LiveAdminEmailMessageDetail,
): LiveAdminEmailMessageSummary {
  return {
    folder: message.folder,
    uid: message.uid,
    messageId: message.messageId,
    subject: message.subject,
    fromAddress: message.fromAddress,
    fromName: message.fromName,
    preview: message.preview,
    receivedAt: message.receivedAt,
    seen: message.seen,
    flagged: message.flagged,
    answered: message.answered,
    hasAttachments: message.hasAttachments,
  };
}

function isDuplicateOfRealSummary(params: {
  syntheticMessage: LiveAdminEmailMessageDetail;
  realMessages: LiveAdminEmailMessageSummary[];
  selfAddress: string;
}): boolean {
  const syntheticTimestampMs = parseTimestampMs(
    params.syntheticMessage.receivedAt,
  );
  const syntheticPreview = normalizeComparableText(
    params.syntheticMessage.preview || params.syntheticMessage.text,
  );
  const syntheticSubject = normalizeComparableText(
    params.syntheticMessage.subject,
  );

  return params.realMessages.some((message) => {
    if (!isSameEmailAddress(message.fromAddress, params.selfAddress)) {
      return false;
    }

    const realTimestampMs = parseTimestampMs(message.receivedAt);
    if (
      syntheticTimestampMs > 0 &&
      realTimestampMs > 0 &&
      Math.abs(realTimestampMs - syntheticTimestampMs) >
        SYNTHETIC_IMAP_MATCH_WINDOW_MS
    ) {
      return false;
    }

    const realPreview = normalizeComparableText(message.preview);
    const realSubject = normalizeComparableText(message.subject);
    return (
      (syntheticSubject &&
        realSubject &&
        syntheticSubject === realSubject &&
        syntheticPreview &&
        realPreview &&
        (syntheticPreview.includes(realPreview) ||
          realPreview.includes(syntheticPreview))) ||
      (syntheticPreview &&
        realPreview &&
        (syntheticPreview.includes(realPreview) ||
          realPreview.includes(syntheticPreview)))
    );
  });
}

function buildSyntheticSentMessagesFromAudit(params: {
  selfAddress: string;
  realMessages: LiveAdminEmailMessageSummary[];
  limit?: number;
  cache?: Map<string, SessionMetadataLookupContext>;
}): LiveAdminEmailMessageDetail[] {
  const entries = searchStructuredAudit(
    '"toolName":"message"',
    SYNTHETIC_SENT_FOLDER_AUDIT_LIMIT,
  );
  const successfulResults = new Map<string, StructuredAuditEntry>();

  for (const entry of entries) {
    if (entry.event_type !== 'tool.result') continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(entry.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(payload.toolName || '').trim() !== 'message') continue;
    if (payload.isError === true) continue;
    const toolCallId = trimText(String(payload.toolCallId || ''));
    if (!toolCallId) continue;
    successfulResults.set(`${entry.session_id}:${toolCallId}`, entry);
  }

  const messages = entries
    .filter((entry) => entry.event_type === 'tool.call')
    .map((entry): LiveAdminEmailMessageDetail | null => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(entry.payload) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (String(payload.toolName || '').trim() !== 'message') {
        return null;
      }

      const argumentsValue =
        payload.arguments &&
        typeof payload.arguments === 'object' &&
        !Array.isArray(payload.arguments)
          ? (payload.arguments as Record<string, unknown>)
          : null;
      if (!argumentsValue) {
        return null;
      }
      if (
        String(argumentsValue.action || '')
          .trim()
          .toLowerCase() !== 'send'
      ) {
        return null;
      }

      const toolCallId = trimText(String(payload.toolCallId || ''));
      if (!toolCallId) {
        return null;
      }
      const successEntry = successfulResults.get(
        `${entry.session_id}:${toolCallId}`,
      );
      if (!successEntry) {
        return null;
      }

      const session = getSessionById(entry.session_id);
      const cache =
        params.cache || new Map<string, SessionMetadataLookupContext>();
      const context = session
        ? loadSessionMetadataLookupContext(session, cache)
        : null;
      const timestampMs =
        parseTimestampMs(successEntry.timestamp) ||
        parseTimestampMs(entry.timestamp);
      if (timestampMs <= 0) {
        return null;
      }

      const rawContent = trimText(
        String(
          argumentsValue.content ||
            argumentsValue.text ||
            argumentsValue.message ||
            '',
        ),
      );
      const { subject: inlineSubject, body } = extractSubjectAndBody(
        rawContent || '',
      );
      const normalizedBody = trimText(body);
      if (!normalizedBody) {
        return null;
      }

      let to = parseSyntheticRecipientValues(argumentsValue.to);
      let cc = parseSyntheticRecipientValues(argumentsValue.cc);
      let bcc = parseSyntheticRecipientValues(argumentsValue.bcc);
      if (to.length === 0 && cc.length === 0 && bcc.length === 0 && context) {
        const sessionTarget = normalizeEmailAddress(context.session.channel_id);
        if (sessionTarget) {
          to = [sessionTarget];
        }
      }
      if (to.length === 0 && cc.length === 0 && bcc.length === 0 && context) {
        const inferred = inferRecipientsFromSessionContext({
          context,
          timestampMs,
        });
        to = inferred.to;
        cc = inferred.cc;
        bcc = inferred.bcc;
      }
      if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
        return null;
      }

      return {
        folder: 'Sent',
        uid: buildSyntheticSentAuditUid(entry.id),
        messageId: `synthetic:audit:${entry.id}`,
        subject:
          trimText(String(argumentsValue.subject || '')) ||
          inlineSubject ||
          DEFAULT_EMAIL_SUBJECT,
        fromAddress: params.selfAddress,
        fromName: null,
        preview: summarizeTextPreview(normalizedBody),
        receivedAt: new Date(timestampMs).toISOString(),
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: false,
        to: toParticipants(to),
        cc: toParticipants(cc),
        bcc: toParticipants(bcc),
        replyTo: [],
        text: normalizedBody,
        attachments: [],
        metadata: context
          ? resolveSessionMetadataForTimestamp({
              context,
              timestampMs,
            })
          : null,
      };
    })
    .filter(
      (message): message is LiveAdminEmailMessageDetail => message !== null,
    )
    .filter(
      (message, index, allMessages) =>
        allMessages.findIndex((candidate) => candidate.uid === message.uid) ===
        index,
    )
    .filter(
      (message) =>
        !isDuplicateOfRealSummary({
          syntheticMessage: message,
          realMessages: params.realMessages,
          selfAddress: params.selfAddress,
        }),
    );

  messages.sort((left, right) => {
    const leftMs = parseTimestampMs(left.receivedAt);
    const rightMs = parseTimestampMs(right.receivedAt);
    if (rightMs !== leftMs) return rightMs - leftMs;
    return right.uid - left.uid;
  });

  return messages.slice(0, Math.max(1, params.limit ?? DEFAULT_MESSAGE_LIMIT));
}

function resolveSessionMetadataForTimestamp(params: {
  context: SessionMetadataLookupContext;
  timestampMs: number;
}): EmailDeliveryMetadata | null {
  const usageEvent = params.context.usageEvents
    .map((entry) => ({
      entry,
      timestampMs: parseTimestampMs(entry.timestamp),
    }))
    .filter(
      ({ timestampMs }) =>
        timestampMs > 0 &&
        Math.abs(timestampMs - params.timestampMs) <=
          METADATA_FALLBACK_WINDOW_MS,
    )
    .sort((left, right) => {
      const distance =
        Math.abs(left.timestampMs - params.timestampMs) -
        Math.abs(right.timestampMs - params.timestampMs);
      if (distance !== 0) return distance;
      return right.timestampMs - left.timestampMs;
    })[0]?.entry;

  const model = trimText(
    usageEvent?.model || params.context.session.model || null,
  );
  const agentId = trimText(
    usageEvent?.agentId || params.context.session.agent_id || null,
  );
  const provider = model ? resolveModelProvider(model) : null;
  const totalTokens =
    usageEvent && usageEvent.totalTokens > 0 ? usageEvent.totalTokens : null;

  if (!agentId && !model && !provider && totalTokens === null) {
    return null;
  }

  return {
    agentId,
    model,
    provider,
    totalTokens,
    tokenSource: null,
  };
}

function resolveSyntheticContentFromAudit(params: {
  context: SessionMetadataLookupContext;
  assistantMessage: StoredMessage;
}): string | null {
  const targetTimestampMs = parseTimestampMs(
    params.assistantMessage.created_at,
  );
  if (targetTimestampMs <= 0) {
    return null;
  }

  const matched = params.context.structuredAudit
    .filter((entry) => entry.event_type === 'tool.call')
    .map((entry) => {
      try {
        return {
          payload: JSON.parse(entry.payload) as Record<string, unknown>,
          timestampMs: parseTimestampMs(entry.timestamp),
        };
      } catch {
        return null;
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        payload: Record<string, unknown>;
        timestampMs: number;
      } => entry !== null,
    )
    .filter(({ payload, timestampMs }) => {
      if (timestampMs <= 0) return false;
      if (
        Math.abs(timestampMs - targetTimestampMs) > METADATA_FALLBACK_WINDOW_MS
      ) {
        return false;
      }
      if (String(payload.toolName || '').trim() !== 'message') {
        return false;
      }
      const argumentsValue =
        payload.arguments &&
        typeof payload.arguments === 'object' &&
        !Array.isArray(payload.arguments)
          ? (payload.arguments as Record<string, unknown>)
          : null;
      if (!argumentsValue) {
        return false;
      }
      return (
        String(argumentsValue.action || '')
          .trim()
          .toLowerCase() === 'send'
      );
    })
    .sort((left, right) => {
      const distance =
        Math.abs(left.timestampMs - targetTimestampMs) -
        Math.abs(right.timestampMs - targetTimestampMs);
      if (distance !== 0) return distance;
      return right.timestampMs - left.timestampMs;
    })[0];
  if (!matched) {
    return null;
  }

  const argumentsValue = matched.payload.arguments as Record<string, unknown>;
  return trimText(
    String(
      argumentsValue.content ||
        argumentsValue.text ||
        argumentsValue.message ||
        '',
    ),
  );
}

function resolveFallbackMetadataFromSession(params: {
  message: LiveAdminEmailMessageDetail;
  selfAddress: string;
  cache: Map<string, SessionMetadataLookupContext>;
}): EmailDeliveryMetadata | null {
  if (params.message.metadata) {
    return params.message.metadata;
  }

  const session = resolveFallbackSessionForMessage(
    params.message,
    params.selfAddress,
  );
  if (!session) {
    return null;
  }

  const targetMs = parseTimestampMs(params.message.receivedAt);
  if (targetMs <= 0) {
    return null;
  }

  const context = loadSessionMetadataLookupContext(session, params.cache);
  const assistantMessage = context.assistantMessages
    .map((entry) => ({
      entry,
      timestampMs: parseTimestampMs(entry.created_at),
    }))
    .filter(
      ({ entry, timestampMs }) =>
        timestampMs > 0 &&
        Math.abs(timestampMs - targetMs) <= METADATA_FALLBACK_WINDOW_MS &&
        String(entry.content || '').includes(SILENT_REPLY_TOKEN),
    )
    .sort((left, right) => {
      const distance =
        Math.abs(left.timestampMs - targetMs) -
        Math.abs(right.timestampMs - targetMs);
      if (distance !== 0) return distance;
      return right.entry.id - left.entry.id;
    })[0];
  if (!assistantMessage) {
    return null;
  }

  return resolveSessionMetadataForTimestamp({
    context,
    timestampMs: assistantMessage.timestampMs,
  });
}

function enrichMessageMetadata(params: {
  message: LiveAdminEmailMessageDetail;
  selfAddress: string;
  cache: Map<string, SessionMetadataLookupContext>;
}): LiveAdminEmailMessageDetail {
  const fallbackMetadata = resolveFallbackMetadataFromSession(params);
  if (!fallbackMetadata) {
    return params.message;
  }
  return {
    ...params.message,
    metadata: fallbackMetadata,
  };
}

function buildSyntheticSentMessages(params: {
  selectedMessage: LiveAdminEmailMessageDetail;
  realThread: LiveAdminEmailMessageDetail[];
  selfAddress: string;
  cache: Map<string, SessionMetadataLookupContext>;
}): LiveAdminEmailMessageDetail[] {
  const session = resolveFallbackSessionForMessage(
    params.selectedMessage,
    params.selfAddress,
  );
  if (!session) {
    return [];
  }

  const context = loadSessionMetadataLookupContext(session, params.cache);
  const targetAddress = normalizeComparableEmailAddress(session.channel_id);
  if (!targetAddress) {
    return [];
  }

  const syntheticMessages = context.assistantMessages
    .map((assistantMessage): LiveAdminEmailMessageDetail | null => {
      const timestampMs = parseTimestampMs(assistantMessage.created_at);
      if (timestampMs <= 0) {
        return null;
      }

      const rawContent = String(assistantMessage.content || '');
      const content = rawContent.includes(SILENT_REPLY_TOKEN)
        ? resolveSyntheticContentFromAudit({
            context,
            assistantMessage,
          })
        : trimText(rawContent);
      if (!content) {
        return null;
      }

      const { subject, body } = extractSubjectAndBody(content);
      const normalizedBody = trimText(body);
      if (!normalizedBody) {
        return null;
      }

      return {
        folder: 'Sent',
        uid: -(SYNTHETIC_THREAD_UID_OFFSET + assistantMessage.id),
        messageId: `synthetic:${assistantMessage.id}`,
        subject:
          subject ||
          trimText(params.selectedMessage.subject) ||
          DEFAULT_EMAIL_SUBJECT,
        fromAddress: params.selfAddress,
        fromName: null,
        preview: summarizeTextPreview(normalizedBody),
        receivedAt: new Date(timestampMs).toISOString(),
        seen: true,
        flagged: false,
        answered: false,
        hasAttachments: false,
        to: [{ name: null, address: targetAddress }],
        cc: [],
        bcc: [],
        replyTo: [],
        text: normalizedBody,
        attachments: [],
        metadata: resolveSessionMetadataForTimestamp({
          context,
          timestampMs,
        }),
      } satisfies LiveAdminEmailMessageDetail;
    })
    .filter(
      (message): message is LiveAdminEmailMessageDetail => message !== null,
    );

  return syntheticMessages.filter((syntheticMessage) => {
    const syntheticTimestampMs = parseTimestampMs(syntheticMessage.receivedAt);
    const syntheticText = normalizeComparableText(
      syntheticMessage.text || syntheticMessage.preview,
    );
    const syntheticSubject = normalizeComparableText(syntheticMessage.subject);

    return !params.realThread.some((realMessage) => {
      if (!isSameEmailAddress(realMessage.fromAddress, params.selfAddress)) {
        return false;
      }

      const realTimestampMs = parseTimestampMs(realMessage.receivedAt);
      if (
        syntheticTimestampMs > 0 &&
        realTimestampMs > 0 &&
        Math.abs(realTimestampMs - syntheticTimestampMs) >
          SYNTHETIC_IMAP_MATCH_WINDOW_MS
      ) {
        return false;
      }

      const realText = normalizeComparableText(
        realMessage.text || realMessage.preview,
      );
      const realSubject = normalizeComparableText(realMessage.subject);

      return (
        (syntheticSubject &&
          realSubject &&
          syntheticSubject === realSubject &&
          syntheticText &&
          realText &&
          (syntheticText.includes(realText) ||
            realText.includes(syntheticText))) ||
        (syntheticText &&
          realText &&
          (syntheticText.includes(realText) ||
            realText.includes(syntheticText)))
      );
    });
  });
}

function collectInlineTextParts(
  structure: MessageStructureObject | undefined,
  parts: Array<{ part: string; type: string }> = [],
): Array<{ part: string; type: string }> {
  if (!structure) return parts;
  if (Array.isArray(structure.childNodes) && structure.childNodes.length > 0) {
    for (const child of structure.childNodes) {
      collectInlineTextParts(child, parts);
    }
    return parts;
  }

  const type = String(structure.type || '')
    .trim()
    .toLowerCase();
  const disposition = String(structure.disposition || '')
    .trim()
    .toLowerCase();
  if (!structure.part || !type.startsWith('text/')) {
    return parts;
  }
  if (disposition === 'attachment') {
    return parts;
  }
  parts.push({ part: structure.part, type });
  return parts;
}

function countAttachments(
  structure: MessageStructureObject | undefined,
): number {
  if (!structure) return 0;
  if (Array.isArray(structure.childNodes) && structure.childNodes.length > 0) {
    return structure.childNodes.reduce(
      (sum, child) => sum + countAttachments(child),
      0,
    );
  }

  const disposition = String(structure.disposition || '')
    .trim()
    .toLowerCase();
  const filename =
    trimText(structure.dispositionParameters?.filename || null) ||
    trimText(structure.parameters?.name || null);
  return disposition === 'attachment' || filename ? 1 : 0;
}

async function readStreamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

async function resolvePreviewText(
  client: ImapFlow,
  uid: number,
  structure: MessageStructureObject | undefined,
): Promise<string | null> {
  const parts = collectInlineTextParts(structure);
  const preferred =
    parts.find((part) => part.type === 'text/plain') ||
    parts.find((part) => part.type === 'text/html') ||
    null;
  if (!preferred) return null;

  const download = await client.download(String(uid), preferred.part, {
    uid: true,
    maxBytes: PREVIEW_MAX_BYTES,
  });
  const buffer = await readStreamToBuffer(download.content);
  const raw = buffer.toString('utf8');
  const text = preferred.type === 'text/html' ? extractTextFromHtml(raw) : raw;
  return summarizeTextPreview(text);
}

function resolveSummarySubject(message: FetchMessageObject): string {
  return trimText(message.envelope?.subject || null) || DEFAULT_EMAIL_SUBJECT;
}

function resolveSummaryTimestamp(message: FetchMessageObject): string | null {
  return (
    normalizeDate(message.internalDate) ||
    normalizeDate(message.envelope?.date) ||
    null
  );
}

async function buildMessageSummary(
  client: ImapFlow,
  folder: string,
  message: FetchMessageObject,
): Promise<LiveAdminEmailMessageSummary> {
  const sender = mapEnvelopeSender(message);
  return {
    folder,
    uid: message.uid,
    messageId: trimText(message.envelope?.messageId || null),
    subject: resolveSummarySubject(message),
    fromAddress: sender.address,
    fromName: sender.name,
    preview: await resolvePreviewText(
      client,
      message.uid,
      message.bodyStructure,
    ),
    receivedAt: resolveSummaryTimestamp(message),
    seen: hasFlag(message.flags, '\\Seen'),
    flagged: hasFlag(message.flags, '\\Flagged'),
    answered: hasFlag(message.flags, '\\Answered'),
    hasAttachments: countAttachments(message.bodyStructure) > 0,
  };
}

async function buildMessageDetail(
  fetched: FetchMessageObject,
  folder: string,
): Promise<LiveAdminEmailMessageDetail | null> {
  if (!Buffer.isBuffer(fetched.source)) {
    return null;
  }

  const parsed = await simpleParser(fetched.source);
  const text = normalizeBodyText(parsed);
  const sender = mapEnvelopeSender(fetched);
  const parsedFrom = mapParsedAddresses(parsed.from)[0] || null;
  return {
    folder,
    uid: fetched.uid,
    messageId: trimText(
      parsed.messageId || fetched.envelope?.messageId || null,
    ),
    subject:
      trimText(parsed.subject || fetched.envelope?.subject || null) ||
      DEFAULT_EMAIL_SUBJECT,
    fromAddress: parsedFrom?.address || sender.address,
    fromName: parsedFrom?.name || sender.name,
    preview: summarizeTextPreview(text),
    receivedAt:
      normalizeDate(parsed.date) || resolveSummaryTimestamp(fetched) || null,
    seen: hasFlag(fetched.flags, '\\Seen'),
    flagged: hasFlag(fetched.flags, '\\Flagged'),
    answered: hasFlag(fetched.flags, '\\Answered'),
    hasAttachments: parsed.attachments.length > 0,
    to: mapParsedAddresses(parsed.to),
    cc: mapParsedAddresses(parsed.cc),
    bcc: mapParsedAddresses(parsed.bcc),
    replyTo: mapParsedAddresses(parsed.replyTo),
    text,
    attachments: parsed.attachments.map((attachment) => ({
      filename: trimText(attachment.filename || null),
      contentType: trimText(attachment.contentType || null),
      size: Number.isFinite(attachment.size) ? attachment.size : null,
    })),
    metadata: parseEmailDeliveryMetadata(parsed.headers),
  };
}

function sortMessageDetailsByTime(
  messages: LiveAdminEmailMessageDetail[],
): LiveAdminEmailMessageDetail[] {
  return [...messages].sort((left, right) => {
    const leftMs = left.receivedAt ? new Date(left.receivedAt).getTime() : 0;
    const rightMs = right.receivedAt ? new Date(right.receivedAt).getTime() : 0;
    if (leftMs !== rightMs) return leftMs - rightMs;
    return left.uid - right.uid;
  });
}

const MESSAGE_DETAIL_FETCH_QUERY = {
  envelope: true,
  flags: true,
  internalDate: true,
  bodyStructure: true,
  source: true,
  threadId: true,
} as const;

async function fetchThreadMessagesAcrossFolders(
  client: ImapFlow,
  params: {
    folder: string;
    selectedMessage: FetchMessageObject;
    threadId: string;
  },
): Promise<Array<{ folder: string; message: FetchMessageObject }>> {
  const listedFolders = await listSelectableFolders(client);
  const folders = [
    params.folder,
    ...listedFolders.map((entry) => entry.path),
  ].filter((value, index, values) => values.indexOf(value) === index);

  const collected: Array<{ folder: string; message: FetchMessageObject }> = [
    {
      folder: params.folder,
      message: params.selectedMessage,
    },
  ];
  const seen = new Set<string>([
    `${params.folder}:${params.selectedMessage.uid}`,
  ]);

  for (const folderPath of folders) {
    const lock =
      folderPath === params.folder
        ? null
        : await client.getMailboxLock(folderPath);
    try {
      const matchedUids =
        (await client.search({ threadId: params.threadId }, { uid: true })) ||
        [];
      const requestedUids = [...new Set(matchedUids)].filter((uid) => {
        const key = `${folderPath}:${uid}`;
        return !seen.has(key);
      });
      if (requestedUids.length === 0) {
        continue;
      }
      const fetchedMessages = await client.fetchAll(
        requestedUids,
        MESSAGE_DETAIL_FETCH_QUERY,
        { uid: true },
      );
      for (const message of fetchedMessages) {
        const key = `${folderPath}:${message.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({ folder: folderPath, message });
      }
    } finally {
      lock?.release();
    }
  }

  return collected;
}

async function fetchHeaderLinkedMessagesAcrossFolders(
  client: ImapFlow,
  params: {
    folder: string;
    selectedMessage: FetchMessageObject;
  },
): Promise<Array<{ folder: string; message: FetchMessageObject }>> {
  if (!Buffer.isBuffer(params.selectedMessage.source)) {
    return [{ folder: params.folder, message: params.selectedMessage }];
  }

  const parsedSelected = await simpleParser(params.selectedMessage.source);
  const selectedMessageId = trimText(
    parsedSelected.messageId ||
      params.selectedMessage.envelope?.messageId ||
      null,
  );
  const referencedMessageIds = normalizeMessageIdList(
    parsedSelected.references,
  );
  const inReplyTo = trimText(parsedSelected.inReplyTo || null);
  if (inReplyTo) {
    referencedMessageIds.push(inReplyTo);
  }

  const searchHeaders: Array<{ headerName: string; headerValue: string }> = [];
  if (selectedMessageId) {
    searchHeaders.push(
      { headerName: 'in-reply-to', headerValue: selectedMessageId },
      { headerName: 'references', headerValue: selectedMessageId },
    );
  }
  for (const messageId of referencedMessageIds) {
    searchHeaders.push({ headerName: 'message-id', headerValue: messageId });
  }
  if (searchHeaders.length === 0) {
    return [{ folder: params.folder, message: params.selectedMessage }];
  }

  const listedFolders = await listSelectableFolders(client);
  const folders = [
    params.folder,
    ...listedFolders.map((entry) => entry.path),
  ].filter((value, index, values) => values.indexOf(value) === index);

  const collected: Array<{ folder: string; message: FetchMessageObject }> = [
    { folder: params.folder, message: params.selectedMessage },
  ];
  const seen = new Set<string>([
    `${params.folder}:${params.selectedMessage.uid}`,
  ]);

  for (const folderPath of folders) {
    const lock =
      folderPath === params.folder
        ? null
        : await client.getMailboxLock(folderPath);
    try {
      const matchedUids = new Set<number>();
      for (const searchHeader of searchHeaders) {
        const uids =
          (await client.search(
            { header: { [searchHeader.headerName]: searchHeader.headerValue } },
            { uid: true },
          )) || [];
        for (const uid of uids) {
          matchedUids.add(uid);
        }
      }

      const requestedUids = [...matchedUids].filter((uid) => {
        const key = `${folderPath}:${uid}`;
        return !seen.has(key);
      });
      if (requestedUids.length === 0) {
        continue;
      }

      const fetchedMessages = await client.fetchAll(
        requestedUids,
        MESSAGE_DETAIL_FETCH_QUERY,
        { uid: true },
      );
      for (const message of fetchedMessages) {
        const key = `${folderPath}:${message.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push({ folder: folderPath, message });
      }
    } finally {
      lock?.release();
    }
  }

  return collected;
}

export async function fetchLiveAdminEmailMailbox(
  config: RuntimeEmailConfig,
  password: string,
): Promise<LiveAdminEmailMailboxSnapshot> {
  return withLiveEmailClient(config, password, async (client) => {
    const configured = new Set(resolveConfiguredFolders(config.folders));
    const listed = await listSelectableFolders(client, {
      statusQuery: { messages: true, unseen: true },
    });
    const selectable = listed.map((entry) => normalizeFolderSummary(entry));
    const folders =
      selectable.length > 0
        ? selectable.sort((left, right) => {
            const rank =
              folderSortRank(left, configured) -
              folderSortRank(right, configured);
            if (rank !== 0) return rank;
            return left.path.localeCompare(right.path);
          })
        : resolveConfiguredFolders(config.folders).map(buildFallbackFolder);

    const defaultFolder =
      folders.find((folder) => folder.specialUse === '\\Inbox')?.path ||
      folders.find((folder) => configured.has(folder.path))?.path ||
      folders[0]?.path ||
      null;

    return {
      address: config.address,
      folders,
      defaultFolder,
    };
  });
}

export async function fetchLiveAdminEmailFolder(
  config: RuntimeEmailConfig,
  password: string,
  params: {
    folder: string;
    limit?: number;
  },
): Promise<LiveAdminEmailFolderSnapshot> {
  return withLiveEmailClient(config, password, async (client) => {
    const folder = String(params.folder || '').trim();
    const limit = Math.max(
      1,
      Math.min(
        MAX_MESSAGE_LIMIT,
        Math.trunc(params.limit || DEFAULT_MESSAGE_LIMIT),
      ),
    );
    const isSentFolder = await isSentFolderPath(client, folder);
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      const recentUids = [...uids]
        .sort((left, right) => right - left)
        .slice(0, limit);
      const fetched =
        recentUids.length > 0
          ? await client.fetchAll(
              recentUids,
              {
                envelope: true,
                flags: true,
                internalDate: true,
                bodyStructure: true,
              },
              { uid: true },
            )
          : [];
      const realMessages = await Promise.all(
        fetched.map((message) => buildMessageSummary(client, folder, message)),
      );
      const syntheticMessages = isSentFolder
        ? buildSyntheticSentMessagesFromAudit({
            selfAddress: config.address,
            realMessages,
            limit,
          }).map((message) => toMessageSummary(message))
        : [];
      const messages = [...realMessages, ...syntheticMessages].filter(
        (message, index, allMessages) =>
          allMessages.findIndex(
            (candidate) =>
              candidate.folder === message.folder &&
              candidate.uid === message.uid,
          ) === index,
      );
      messages.sort((left, right) => {
        const leftMs = left.receivedAt
          ? new Date(left.receivedAt).getTime()
          : 0;
        const rightMs = right.receivedAt
          ? new Date(right.receivedAt).getTime()
          : 0;
        if (rightMs !== leftMs) return rightMs - leftMs;
        return right.uid - left.uid;
      });
      return { folder, messages: messages.slice(0, limit) };
    } finally {
      lock.release();
    }
  });
}

export async function fetchLiveAdminEmailMessage(
  config: RuntimeEmailConfig,
  password: string,
  params: {
    folder: string;
    uid: number;
  },
): Promise<LiveAdminEmailMessageThreadSnapshot> {
  return withLiveEmailClient(config, password, async (client) => {
    const folder = String(params.folder || '').trim();
    const uid = Math.trunc(params.uid);
    const isSentFolder = await isSentFolderPath(client, folder);
    if (uid < 0 && isSentFolder) {
      const syntheticMessage = buildSyntheticSentMessagesFromAudit({
        selfAddress: config.address,
        realMessages: [],
      }).find((message) => message.folder === folder && message.uid === uid);
      return {
        message: syntheticMessage || null,
        thread: syntheticMessage ? [syntheticMessage] : [],
      };
    }

    const normalizedUid = Math.max(1, uid);
    const lock = await client.getMailboxLock(folder);
    let fetched: FetchMessageObject | null = null;
    try {
      const selected = await client.fetchOne(
        String(normalizedUid),
        MESSAGE_DETAIL_FETCH_QUERY,
        { uid: true },
      );
      fetched = selected || null;
    } finally {
      lock.release();
    }
    if (!fetched) {
      return {
        message: null,
        thread: [],
      };
    }
    const threadFetched = fetched.threadId
      ? await fetchThreadMessagesAcrossFolders(client, {
          folder,
          selectedMessage: fetched,
          threadId: fetched.threadId,
        })
      : [{ folder, message: fetched }];
    const linkedFetched =
      threadFetched.length > 1
        ? []
        : await fetchHeaderLinkedMessagesAcrossFolders(client, {
            folder,
            selectedMessage: fetched,
          });
    const combinedFetched = [...threadFetched, ...linkedFetched].filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) =>
            candidate.folder === entry.folder &&
            candidate.message.uid === entry.message.uid,
        ) === index,
    );
    const metadataLookupCache = new Map<string, SessionMetadataLookupContext>();
    const realThread = (
      await Promise.all(
        combinedFetched.map(({ folder: messageFolder, message }) =>
          buildMessageDetail(message, messageFolder),
        ),
      )
    )
      .filter(
        (message): message is LiveAdminEmailMessageDetail => message !== null,
      )
      .map((message) =>
        enrichMessageMetadata({
          message,
          selfAddress: config.address,
          cache: metadataLookupCache,
        }),
      );
    const selectedRealMessage =
      realThread.find(
        (message) => message.folder === folder && message.uid === normalizedUid,
      ) || realThread[0];
    const syntheticThread = selectedRealMessage
      ? buildSyntheticSentMessages({
          selectedMessage: selectedRealMessage,
          realThread,
          selfAddress: config.address,
          cache: metadataLookupCache,
        })
      : [];
    const thread = sortMessageDetailsByTime(
      [...realThread, ...syntheticThread].filter(
        (message, index, messages) =>
          messages.findIndex(
            (candidate) =>
              candidate.folder === message.folder &&
              candidate.uid === message.uid,
          ) === index,
      ),
    );
    return {
      message:
        thread.find(
          (message) =>
            message.folder === folder && message.uid === normalizedUid,
        ) || null,
      thread,
    };
  });
}

export async function deleteLiveAdminEmailMessage(
  config: RuntimeEmailConfig,
  password: string,
  params: {
    folder: string;
    uid: number;
  },
): Promise<LiveAdminEmailDeleteResult> {
  return withLiveEmailClient(config, password, async (client) => {
    const folder = String(params.folder || '').trim();
    const uid = Math.max(1, Math.trunc(params.uid));
    const lock = await client.getMailboxLock(folder);
    try {
      const trashFolder = await resolveTrashFolderPath(client);
      const currentFolderIsTrash =
        isTrashFolderCandidate({ path: folder, name: folder }) ||
        normalizeFolderPath(trashFolder) === normalizeFolderPath(folder);

      if (!currentFolderIsTrash && trashFolder) {
        const moved = await client.messageMove(String(uid), trashFolder, {
          uid: true,
        });
        if (moved === false) {
          throw new Error('Failed to move message to trash.');
        }
        return {
          deleted: true,
          targetFolder: trashFolder,
          permanent: false,
        };
      }

      const deleted = await client.messageDelete(String(uid), { uid: true });
      if (!deleted) {
        throw new Error('Failed to delete message.');
      }
      return {
        deleted: true,
        targetFolder: null,
        permanent: true,
      };
    } finally {
      lock.release();
    }
  });
}
