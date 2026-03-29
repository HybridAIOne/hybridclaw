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
import type { IMessageOutboundMessageRef } from './self-echo-cache.js';

const execFileAsync = promisify(execFile);

interface LocalMessageRow {
  rowid: number;
  messageGuid: string | null;
  text: string | null;
  attributedBody: Buffer | null;
  isFromMe: number;
  handle: string | null;
  chatGuid: string | null;
  chatIdentifier: string | null;
  chatDisplayName: string | null;
}

function decodeAttributedBody(value: Buffer | null): string {
  if (!Buffer.isBuffer(value) || value.length === 0) return '';
  const withoutControlChars = Array.from(value.toString('utf8'), (char) =>
    char.charCodeAt(0) < 32 ? ' ' : char,
  ).join('');
  const utf8 = withoutControlChars.replace(/\uFFFD/g, '').trim();
  if (!utf8) return '';

  const directText = utf8.match(/NSString[^\w]+(.+?)\s{2,}/);
  if (directText?.[1]?.trim()) {
    return directText[1].trim();
  }

  const printableRuns = utf8.match(/[ -~\u00a0-\u024f]{2,}/g) || [];
  return printableRuns.join(' ').trim();
}

function resolveMessageText(row: LocalMessageRow): string {
  const direct = String(row.text || '').trim();
  if (direct) return direct;
  return decodeAttributedBody(row.attributedBody);
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

function resolveConversationId(row: LocalMessageRow): string {
  return (
    String(row.chatGuid || '').trim() ||
    String(row.chatIdentifier || '').trim() ||
    String(row.handle || '').trim()
  );
}

async function runIMessageCli(args: string[]): Promise<void> {
  await execFileAsync(IMESSAGE_CLI_PATH, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
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
  let lastRowId = 0;

  const poll = async (): Promise<void> => {
    if (!db) return;
    const rows = db
      .prepare(
        `
          SELECT
            m.ROWID AS rowid,
            m.guid AS messageGuid,
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
        `,
      )
      .all(lastRowId) as LocalMessageRow[];

    for (const row of rows) {
      lastRowId = Math.max(lastRowId, Number(row.rowid) || lastRowId);
      const config = getConfigSnapshot().imessage;
      const inbound = normalizeIMessageInbound({
        config,
        backend: 'local',
        conversationId: resolveConversationId(row),
        senderHandle:
          String(row.handle || '').trim() ||
          String(row.chatIdentifier || '').trim(),
        text: resolveMessageText(row),
        isGroup: isGroupConversation(row),
        isFromMe: row.isFromMe === 1,
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
      if (process.platform !== 'darwin') {
        throw new Error(
          'The local iMessage backend is only supported on macOS.',
        );
      }
      db = new Database(IMESSAGE_DB_PATH, {
        readonly: true,
        fileMustExist: true,
      });
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
      db?.close();
      db = null;
      lastRowId = 0;
    },
  };
}
