import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  getConfigSnapshot,
  IMESSAGE_CLI_PATH,
  IMESSAGE_DB_PATH,
  IMESSAGE_POLL_INTERVAL_MS,
  IMESSAGE_TEXT_CHUNK_LIMIT,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import type {
  IMessageBackendFactoryParams,
  IMessageBackendInstance,
  IMessageMediaSendParams,
} from './backend.js';
import { prepareIMessageTextChunks } from './delivery.js';
import { buildIMessageChannelId, normalizeIMessageHandle } from './handle.js';
import { normalizeIMessageInbound } from './inbound.js';
import {
  assertLocalIMessageBackendReady,
  formatMissingIMessageCliMessage,
} from './local-prereqs.js';
import type { IMessageOutboundMessageRef } from './self-echo-cache.js';

const execFileAsync = promisify(execFile);
const LOCAL_MESSAGE_POLL_SQL = `
  SELECT
    m.ROWID AS rowid,
    m.guid AS messageGuid,
    m.date AS messageDate,
    m.text AS text,
    m.attributedBody AS attributedBody,
    m.is_from_me AS isFromMe,
    h.id AS handle,
    c.guid AS chatGuid,
    c.chat_identifier AS chatIdentifier,
    c.display_name AS chatDisplayName
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
  LIMIT 200
`;

interface LocalMessageRow {
  rowid: number;
  messageGuid: string | null;
  messageDate: number | null;
  text: string | null;
  attributedBody: Buffer | null;
  isFromMe: number;
  handle: string | null;
  chatGuid: string | null;
  chatIdentifier: string | null;
  chatDisplayName: string | null;
}

function normalizeLocalInboundText(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const prefixedSlashCommandMatch = trimmed.match(
    /^(?:[^/\s]{1,3}\s+)(\/[a-z][\s\S]*)$/i,
  );
  if (prefixedSlashCommandMatch) {
    return prefixedSlashCommandMatch[1].trim();
  }

  return trimmed;
}

function decodeAttributedBodyText(value: Buffer | null): string | null {
  if (!Buffer.isBuffer(value) || value.length === 0) return null;

  const utf8 = value.toString('utf8').replace(/\uFFFD/g, '');
  if (!utf8) return null;

  const nsStringIndex = utf8.indexOf('NSString');
  if (nsStringIndex < 0) {
    return null;
  }

  let candidate = utf8.slice(nsStringIndex + 'NSString'.length);
  candidate = candidate
    .replace(/^[^\p{L}\p{N}/#@([{\-"'+]+/u, '')
    .replace(
      /(?:NSDictionary|NSNumber|NSValue|__kIMMessagePartAttributeName).*$/su,
      '',
    );

  const typedStreamMarker = `${String.fromCharCode(2)}iI${String.fromCharCode(1)}`;
  const typedStreamMarkerIndex = candidate.indexOf(typedStreamMarker);
  if (typedStreamMarkerIndex >= 0) {
    candidate = candidate.slice(0, typedStreamMarkerIndex);
  }

  candidate = Array.from(candidate, (char) =>
    char.charCodeAt(0) < 32 ? ' ' : char,
  )
    .join('')
    .trim();

  return candidate || null;
}

function resolveMessageText(row: LocalMessageRow): string {
  const direct = normalizeLocalInboundText(String(row.text || ''));
  if (direct) return direct;

  const decodedAttributedBody = normalizeLocalInboundText(
    decodeAttributedBodyText(row.attributedBody) || '',
  );
  if (decodedAttributedBody) {
    return decodedAttributedBody;
  }

  if (Buffer.isBuffer(row.attributedBody) && row.attributedBody.length > 0) {
    logger.warn(
      {
        rowid: row.rowid,
        messageGuid: row.messageGuid,
        attributedBodyBytes: row.attributedBody.length,
      },
      'Skipping local iMessage row without plain text; attributedBody decoding is not supported',
    );
  }
  return '';
}

function isGroupConversation(row: LocalMessageRow): boolean {
  const chatGuid = String(row.chatGuid || '')
    .trim()
    .toLowerCase();
  const chatIdentifier = String(row.chatIdentifier || '')
    .trim()
    .toLowerCase();
  return (
    Boolean(String(row.chatDisplayName || '').trim()) ||
    chatGuid.includes('chat') ||
    chatIdentifier.includes('chat')
  );
}

function isSelfChatConversation(row: LocalMessageRow): boolean {
  if (isGroupConversation(row)) return false;
  const sender = normalizeIMessageHandle(
    String(row.handle || row.chatIdentifier || ''),
  );
  const chatIdentifier = normalizeIMessageHandle(
    String(row.chatIdentifier || ''),
  );
  return Boolean(sender && chatIdentifier && sender === chatIdentifier);
}

function resolveConversationId(row: LocalMessageRow): string {
  return (
    String(row.chatGuid || '').trim() ||
    String(row.chatIdentifier || '').trim() ||
    String(row.handle || '').trim()
  );
}

async function runIMessageCli(args: string[]): Promise<void> {
  try {
    await execFileAsync(IMESSAGE_CLI_PATH, args, {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code || '')
        : '';
    if (code === 'ENOENT' || code === 'EACCES') {
      throw new Error(formatMissingIMessageCliMessage(IMESSAGE_CLI_PATH));
    }
    throw error;
  }
}

function resolveCliTarget(target: string): string {
  const normalized = normalizeIMessageHandle(target);
  if (!normalized) {
    throw new Error(`Invalid iMessage target: ${target}`);
  }
  return normalized.startsWith('chat:')
    ? normalized.slice('chat:'.length)
    : normalized;
}

export function createLocalIMessageBackend(
  params: IMessageBackendFactoryParams,
): IMessageBackendInstance {
  let db: Database.Database | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollStatement: ReturnType<Database.Database['prepare']> | null = null;
  let lastRowId = 0;

  const poll = async (): Promise<void> => {
    if (!db || !pollStatement) return;
    const rows = pollStatement.all(lastRowId) as LocalMessageRow[];

    for (const row of rows) {
      lastRowId = Math.max(lastRowId, Number(row.rowid) || lastRowId);
      const config = getConfigSnapshot().imessage;
      const isSelfChat = isSelfChatConversation(row);
      const inbound = normalizeIMessageInbound({
        config,
        backend: 'local',
        conversationId: resolveConversationId(row),
        senderHandle:
          String(row.handle || '').trim() ||
          String(row.chatIdentifier || '').trim(),
        text: resolveMessageText(row),
        isGroup: isGroupConversation(row),
        isFromMe: row.isFromMe === 1 && !isSelfChat,
        displayName: row.chatDisplayName,
        messageId: row.messageGuid || `local:${row.rowid}`,
        rawEvent: row,
      });
      if (!inbound) continue;
      await params.onInbound(inbound);
    }
  };

  return {
    async start(): Promise<void> {
      if (pollTimer) return;
      await assertLocalIMessageBackendReady(IMESSAGE_CLI_PATH);
      db = new Database(IMESSAGE_DB_PATH, {
        readonly: true,
        fileMustExist: true,
      });
      pollStatement = db.prepare(LOCAL_MESSAGE_POLL_SQL);
      const row = db
        .prepare('SELECT COALESCE(MAX(ROWID), 0) AS rowid FROM message')
        .get() as { rowid?: number } | undefined;
      lastRowId = Number(row?.rowid || 0);
      pollTimer = setInterval(() => {
        void poll().catch((error) => {
          logger.warn({ error }, 'Local iMessage poll failed');
        });
      }, IMESSAGE_POLL_INTERVAL_MS);
    },
    async sendText(
      target: string,
      text: string,
    ): Promise<IMessageOutboundMessageRef[]> {
      const cliTarget = resolveCliTarget(target);
      const channelId = buildIMessageChannelId(target);
      const refs: IMessageOutboundMessageRef[] = [];
      for (const chunk of prepareIMessageTextChunks(
        text,
        IMESSAGE_TEXT_CHUNK_LIMIT,
      )) {
        await runIMessageCli([
          'send',
          '--to',
          cliTarget,
          '--text',
          chunk,
          '--service',
          'imessage',
        ]);
        refs.push({
          channelId,
          text: chunk,
        });
      }
      return refs;
    },
    async sendMedia(
      params: IMessageMediaSendParams,
    ): Promise<IMessageOutboundMessageRef | null> {
      const cliTarget = resolveCliTarget(params.target);
      const channelId = buildIMessageChannelId(params.target);
      const args = ['send', '--to', cliTarget, '--file', params.filePath];
      const caption = String(params.caption || '').trim();
      if (caption) {
        args.push('--text', caption);
      }
      args.push('--service', 'imessage');
      await runIMessageCli(args);
      return {
        channelId,
        text: caption || null,
      };
    },
    async shutdown(): Promise<void> {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      pollStatement = null;
      db?.close();
      db = null;
      lastRowId = 0;
    },
  };
}
