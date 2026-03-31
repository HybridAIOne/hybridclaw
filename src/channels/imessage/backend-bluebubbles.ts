import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import {
  getConfigSnapshot,
  IMESSAGE_ALLOW_PRIVATE_NETWORK,
  IMESSAGE_MEDIA_MAX_MB,
  IMESSAGE_PASSWORD,
  IMESSAGE_SERVER_URL,
  IMESSAGE_TEXT_CHUNK_LIMIT,
} from '../../config/config.js';
import { SlidingWindowRateLimiter } from '../discord/rate-limiter.js';
import {
  readWebhookJsonBody,
  sendWebhookJson,
  WebhookHttpError,
} from '../webhook-http.js';
import type {
  IMessageBackendFactoryParams,
  IMessageBackendInstance,
  IMessageMediaSendParams,
} from './backend.js';
import { prepareIMessageTextChunks } from './delivery.js';
import {
  buildIMessageChannelId,
  normalizeIMessageHandle,
  toBlueBubblesChatGuid,
} from './handle.js';
import { normalizeIMessageInbound } from './inbound.js';
import type { IMessageOutboundMessageRef } from './self-echo-cache.js';

const MAX_WEBHOOK_BYTES = 1_000_000;
const WEBHOOK_RATE_LIMIT = 120;
const webhookRateLimiter = new SlidingWindowRateLimiter(60_000);

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return net.isIP(mapped) === 4 ? isPrivateIpv4(mapped) : false;
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateHostLabel(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  return net.isIP(normalized) > 0 ? isPrivateIp(normalized) : false;
}

async function assertSafeBlueBubblesBaseUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid BlueBubbles server URL: ${rawUrl}`);
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('BlueBubbles server URL must use http or https.');
  }
  if (!IMESSAGE_ALLOW_PRIVATE_NETWORK) {
    const hostname = parsed.hostname.trim().toLowerCase();
    if (isPrivateHostLabel(hostname)) {
      throw new Error(`Blocked BlueBubbles server URL host: ${hostname}`);
    }
    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (resolved.some((entry) => isPrivateIp(entry.address))) {
      throw new Error(`Blocked BlueBubbles server URL host: ${hostname}`);
    }
  }

  return parsed;
}

function safeEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  if (valueBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(valueBuffer, expectedBuffer);
}

function readWebhookPassword(
  req: IncomingMessage,
  url: URL,
): string | undefined {
  const headerValue = req.headers['x-hybridclaw-imessage-password'];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }
  // Header auth is preferred. Query-param secrets remain as a compatibility
  // fallback because some relay/proxy setups cannot inject custom headers.
  for (const key of ['password', 'guid', 'token']) {
    const value = url.searchParams.get(key);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

async function sendBlueBubblesRequest(
  baseUrl: URL,
  pathname: string,
  init: RequestInit,
): Promise<unknown> {
  if (!IMESSAGE_PASSWORD.trim()) {
    throw new Error(
      'IMESSAGE_PASSWORD or imessage.password is required for the BlueBubbles backend.',
    );
  }

  const url = new URL(pathname, baseUrl);
  // BlueBubbles expects the REST API password as a query parameter.
  // We prefer header-based auth for inbound webhooks, but outbound requests
  // must follow the server API contract here.
  url.searchParams.set('password', IMESSAGE_PASSWORD);

  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const errorMessage =
      typeof body?.message === 'string'
        ? body.message
        : `BlueBubbles request failed with ${response.status}`;
    throw new Error(errorMessage);
  }
  return body;
}

export function createBlueBubblesIMessageBackend(
  params: IMessageBackendFactoryParams,
): IMessageBackendInstance {
  let validatedBaseUrl: URL | null = null;

  const ensureValidatedBaseUrl = async (): Promise<URL> => {
    if (validatedBaseUrl) {
      return validatedBaseUrl;
    }
    if (!IMESSAGE_SERVER_URL.trim()) {
      throw new Error(
        'imessage.serverUrl is required for the BlueBubbles backend.',
      );
    }
    validatedBaseUrl = await assertSafeBlueBubblesBaseUrl(IMESSAGE_SERVER_URL);
    return validatedBaseUrl;
  };

  return {
    async start(): Promise<void> {
      await ensureValidatedBaseUrl();
    },
    async sendText(
      target: string,
      text: string,
    ): Promise<IMessageOutboundMessageRef[]> {
      const baseUrl = await ensureValidatedBaseUrl();
      const normalizedTarget = normalizeIMessageHandle(target);
      const chatGuid = toBlueBubblesChatGuid(target);
      if (!normalizedTarget || !chatGuid) {
        throw new Error(`Invalid iMessage target: ${target}`);
      }

      const refs: IMessageOutboundMessageRef[] = [];
      for (const chunk of prepareIMessageTextChunks(
        text,
        IMESSAGE_TEXT_CHUNK_LIMIT,
      )) {
        const tempGuid = `temp-${randomUUID()}`;
        const body = (await sendBlueBubblesRequest(
          baseUrl,
          '/api/v1/message/text',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              chatGuid,
              tempGuid,
              message: chunk,
            }),
          },
        )) as Record<string, unknown> | null;
        const data =
          body && typeof body.data === 'object' && body.data
            ? (body.data as Record<string, unknown>)
            : null;
        refs.push({
          channelId: buildIMessageChannelId(normalizedTarget),
          messageId: String(data?.guid || tempGuid).trim() || tempGuid,
          text: chunk,
        });
      }
      return refs;
    },
    async sendMedia(
      params: IMessageMediaSendParams,
    ): Promise<IMessageOutboundMessageRef | null> {
      const baseUrl = await ensureValidatedBaseUrl();
      const normalizedTarget = normalizeIMessageHandle(params.target);
      const chatGuid = toBlueBubblesChatGuid(params.target);
      if (!normalizedTarget || !chatGuid) {
        throw new Error(`Invalid iMessage target: ${params.target}`);
      }

      const stat = await fs.stat(params.filePath);
      if (stat.size > IMESSAGE_MEDIA_MAX_MB * 1024 * 1024) {
        throw new Error('iMessage attachment exceeds configured media limit.');
      }

      const formData = new FormData();
      const bytes = await fs.readFile(params.filePath);
      const filename =
        String(params.filename || '').trim() ||
        params.filePath.split('/').at(-1) ||
        'attachment';
      formData.set('chatGuid', chatGuid);
      formData.set('tempGuid', `temp-${randomUUID()}`);
      const caption = String(params.caption || '').trim();
      if (caption) {
        formData.set('message', caption);
      }
      formData.set(
        'attachment',
        new Blob([bytes], {
          type: String(params.mimeType || '').trim() || undefined,
        }),
        filename,
      );

      const body = (await sendBlueBubblesRequest(
        baseUrl,
        '/api/v1/message/attachment',
        {
          method: 'POST',
          body: formData,
        },
      )) as Record<string, unknown> | null;
      const data =
        body && typeof body.data === 'object' && body.data
          ? (body.data as Record<string, unknown>)
          : null;
      return {
        channelId: buildIMessageChannelId(normalizedTarget),
        messageId: String(data?.guid || '').trim() || null,
        text: caption || null,
      };
    },
    async handleWebhook(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<boolean> {
      const url = new URL(req.url || '/', 'http://localhost');
      const decision = webhookRateLimiter.check(
        req.socket.remoteAddress || 'unknown',
        WEBHOOK_RATE_LIMIT,
      );
      if (!decision.allowed) {
        sendWebhookJson(res, 429, {
          error: 'Too many BlueBubbles webhook requests.',
        });
        return true;
      }

      const expectedPassword = IMESSAGE_PASSWORD.trim();
      const suppliedPassword = String(
        readWebhookPassword(req, url) || '',
      ).trim();
      if (
        !expectedPassword ||
        !suppliedPassword ||
        !safeEqual(suppliedPassword, expectedPassword)
      ) {
        sendWebhookJson(res, 401, {
          error: 'Unauthorized BlueBubbles webhook.',
        });
        return true;
      }

      let payload: Record<string, unknown>;
      try {
        payload = (await readWebhookJsonBody(req, {
          maxBytes: MAX_WEBHOOK_BYTES,
          tooLargeMessage: 'BlueBubbles webhook body too large.',
          tooLargeStatusCode: 400,
          invalidJsonMessage: 'BlueBubbles webhook body must be valid JSON.',
          requireObject: true,
          invalidShapeMessage: 'BlueBubbles webhook body must be JSON.',
        })) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode =
          error instanceof WebhookHttpError ? error.statusCode : 500;
        sendWebhookJson(res, statusCode, { error: message });
        return true;
      }

      if (String(payload.type || '').trim() !== 'new-message') {
        sendWebhookJson(res, 200, { ok: true, ignored: true });
        return true;
      }

      const data =
        payload.data &&
        typeof payload.data === 'object' &&
        !Array.isArray(payload.data)
          ? (payload.data as Record<string, unknown>)
          : null;
      const handle =
        data?.handle &&
        typeof data.handle === 'object' &&
        !Array.isArray(data.handle)
          ? (data.handle as Record<string, unknown>)
          : null;
      const chats = Array.isArray(data?.chats) ? data.chats : [];
      const firstChat =
        chats[0] && typeof chats[0] === 'object' && !Array.isArray(chats[0])
          ? (chats[0] as Record<string, unknown>)
          : null;
      const participants = Array.isArray(firstChat?.participants)
        ? firstChat.participants
        : [];
      const senderHandle = String(handle?.address || '').trim();
      const conversationId =
        String(firstChat?.guid || '').trim() || senderHandle;
      const displayName =
        String(firstChat?.displayName || '').trim() || senderHandle;

      const inbound = normalizeIMessageInbound({
        config: getConfigSnapshot().imessage,
        backend: 'bluebubbles',
        conversationId,
        senderHandle,
        text: String(data?.text || '').trim(),
        isGroup:
          participants.length > 1 ||
          Boolean(String(firstChat?.displayName || '').trim()),
        isFromMe: data?.isFromMe === true,
        displayName,
        messageId: String(data?.guid || '').trim() || null,
        rawEvent: payload,
      });
      if (inbound) {
        await params.onInbound(inbound);
      }

      sendWebhookJson(res, 200, { ok: true });
      return true;
    },
    async shutdown(): Promise<void> {
      validatedBaseUrl = null;
    },
  };
}
