import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { runDiscordToolAction } from '../channels/discord/runtime.js';
import {
  type DiscordToolActionRequest,
  normalizeDiscordToolAction,
} from '../channels/discord/tool-actions.js';
import {
  GATEWAY_API_TOKEN,
  HEALTH_HOST,
  HEALTH_PORT,
  WEB_API_TOKEN,
} from '../config/config.js';
import { claimQueuedProactiveMessages } from '../memory/db.js';
import {
  type GatewayChatRequest,
  type GatewayCommandRequest,
  getGatewayHistory,
  getGatewayStatus,
  handleGatewayCommand,
  handleGatewayMessage,
} from './gateway-service.js';
import type { GatewayChatRequestBody } from './gateway-types.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { logger } from '../logger.js';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import type { ToolProgressEvent } from '../types.js';

const SITE_DIR = resolveInstallPath('docs');
const MAX_REQUEST_BYTES = 1_000_000; // 1MB

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

type ApiChatRequestBody = GatewayChatRequestBody & { stream?: boolean };
type ApiDiscordActionRequestBody = Partial<DiscordToolActionRequest>;

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isMessageSendAction(rawAction: unknown): boolean {
  if (typeof rawAction !== 'string') return false;
  const compact = rawAction
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return (
    compact === 'send' ||
    compact === 'sendmessage' ||
    compact === 'dm' ||
    compact === 'post' ||
    compact === 'reply' ||
    compact === 'respond'
  );
}

function hasMessageSendToolExecution(
  result: Awaited<ReturnType<typeof handleGatewayMessage>>,
): boolean {
  if (!Array.isArray(result.toolExecutions)) return false;
  for (const execution of result.toolExecutions) {
    if (
      String(execution.name || '')
        .trim()
        .toLowerCase() !== 'message'
    )
      continue;

    const argsObj = parseJsonObject(execution.arguments);
    if (argsObj && isMessageSendAction(argsObj.action)) return true;

    const resultObj = parseJsonObject(execution.result);
    if (resultObj && isMessageSendAction(resultObj.action)) return true;
  }
  return false;
}

function fallbackResultFromTools(
  result: Awaited<ReturnType<typeof handleGatewayMessage>>,
): string {
  const executions = Array.isArray(result.toolExecutions)
    ? result.toolExecutions
    : [];
  for (let i = executions.length - 1; i >= 0; i -= 1) {
    const execution = executions[i];
    if (execution.isError) continue;
    const text = String(execution.result || '').trim();
    if (!text) continue;
    return text;
  }
  return 'Done.';
}

function normalizeSilentMessageSendReply(
  result: Awaited<ReturnType<typeof handleGatewayMessage>>,
): Awaited<ReturnType<typeof handleGatewayMessage>> {
  if (result.status !== 'success') return result;
  const sentByMessageTool = hasMessageSendToolExecution(result);
  const rawResult = result.result || '';
  if (isSilentReply(rawResult)) {
    return {
      ...result,
      result: sentByMessageTool
        ? 'Message sent.'
        : fallbackResultFromTools(result),
    };
  }
  const cleanedResult = stripSilentToken(rawResult);
  if (cleanedResult === rawResult) return result;
  const nextResult = cleanedResult.trim()
    ? cleanedResult
    : sentByMessageTool
      ? 'Message sent.'
      : fallbackResultFromTools(result);
  return {
    ...result,
    result: nextResult,
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function hasApiAuth(req: IncomingMessage): boolean {
  const authHeader = req.headers.authorization || '';
  const gatewayTokenMatch =
    Boolean(GATEWAY_API_TOKEN) && authHeader === `Bearer ${GATEWAY_API_TOKEN}`;

  if (!WEB_API_TOKEN) {
    return gatewayTokenMatch || isLoopbackAddress(req.socket.remoteAddress);
  }
  if (authHeader === `Bearer ${WEB_API_TOKEN}`) return true;
  return gatewayTokenMatch;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res: ServerResponse, statusCode: number, text: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error('Request body too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

function resolveSiteFile(pathname: string): string | null {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.resolve(SITE_DIR, `.${normalized}`);
  if (!candidate.startsWith(SITE_DIR)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    return null;
  return candidate;
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveSiteFile(
    pathname === '/chat' ? '/chat.html' : pathname,
  );
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(fs.readFileSync(filePath));
  return true;
}

async function handleApiChat(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<ApiChatRequestBody>;
  const wantsStream = body.stream === true;

  const content = body.content?.trim();
  if (!content) {
    sendJson(res, 400, { error: 'Missing `content` in request body.' });
    return;
  }

  const chatRequest: GatewayChatRequest = {
    sessionId: body.sessionId || 'web:default',
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    userId: body.userId || 'web-user',
    username: body.username ?? 'web',
    content,
    chatbotId: body.chatbotId,
    enableRag: body.enableRag,
    model: body.model,
  };

  if (wantsStream) {
    await handleApiChatStream(req, res, chatRequest);
    return;
  }

  const result = normalizeSilentMessageSendReply(
    await handleGatewayMessage(chatRequest),
  );
  sendJson(res, result.status === 'success' ? 200 : 500, result);
}

async function handleApiChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  chatRequest: GatewayChatRequest,
): Promise<void> {
  const sendEvent = (payload: object): void => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(payload)}\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const onToolProgress = (event: ToolProgressEvent): void => {
    sendEvent({
      type: 'tool',
      toolName: event.toolName,
      phase: event.phase,
      preview: event.preview,
      durationMs: event.durationMs,
    });
  };

  const streamFilter = createSilentReplyStreamFilter();
  const onTextDelta = (delta: string): void => {
    const filteredDelta = streamFilter.push(delta);
    if (!filteredDelta) return;
    sendEvent({
      type: 'text',
      delta: filteredDelta,
    });
  };

  try {
    let result = normalizeSilentMessageSendReply(
      await handleGatewayMessage({
        ...chatRequest,
        onTextDelta,
        onToolProgress,
      }),
    );
    if (result.status === 'success') {
      const bufferedDelta = streamFilter.flush();
      if (bufferedDelta) {
        sendEvent({
          type: 'text',
          delta: bufferedDelta,
        });
      }
      if (streamFilter.isSilent() && hasMessageSendToolExecution(result)) {
        result = {
          ...result,
          result: 'Message sent.',
        };
      }
    }
    sendEvent({ type: 'result', result });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendEvent({
      type: 'result',
      result: {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: errorMessage,
      },
    });
    logger.error(
      { error, reqUrl: '/api/chat' },
      'Gateway streaming chat failed',
    );
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }

  req.on('close', () => {
    if (!res.writableEnded) {
      res.end();
    }
  });
}

async function handleApiCommand(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<GatewayCommandRequest>;
  const args = Array.isArray(body.args)
    ? body.args.map((value) => String(value))
    : [];
  if (args.length === 0) {
    sendJson(res, 400, {
      error: 'Missing command. Provide non-empty `args` array.',
    });
    return;
  }

  const commandRequest: GatewayCommandRequest = {
    sessionId: body.sessionId || 'web:default',
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    args,
  };
  const result = await handleGatewayCommand(commandRequest);
  sendJson(res, result.kind === 'error' ? 400 : 200, result);
}

async function handleApiDiscordAction(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiDiscordActionRequestBody;
  const action =
    typeof body.action === 'string'
      ? normalizeDiscordToolAction(body.action)
      : null;
  if (!action) {
    sendJson(res, 400, {
      error:
        'Invalid `action`. Allowed: "read", "member-info", "channel-info", "send", "react", "quote-reply", "edit", "delete", "pin", "unpin", "thread-create", "thread-reply".',
    });
    return;
  }

  const request: DiscordToolActionRequest = {
    action,
    channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
    guildId: typeof body.guildId === 'string' ? body.guildId : undefined,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    memberId: typeof body.memberId === 'string' ? body.memberId : undefined,
    username: typeof body.username === 'string' ? body.username : undefined,
    user: typeof body.user === 'string' ? body.user : undefined,
    resolveAmbiguous:
      body.resolveAmbiguous === 'best' || body.resolveAmbiguous === 'error'
        ? body.resolveAmbiguous
        : undefined,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    before: typeof body.before === 'string' ? body.before : undefined,
    after: typeof body.after === 'string' ? body.after : undefined,
    around: typeof body.around === 'string' ? body.around : undefined,
    content: typeof body.content === 'string' ? body.content : undefined,
    components:
      Array.isArray(body.components) ||
      (body.components !== null && typeof body.components === 'object')
        ? body.components
        : undefined,
    contextChannelId:
      typeof body.contextChannelId === 'string'
        ? body.contextChannelId
        : undefined,
    messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
    emoji: typeof body.emoji === 'string' ? body.emoji : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    autoArchiveDuration:
      typeof body.autoArchiveDuration === 'number'
        ? body.autoArchiveDuration
        : undefined,
  };

  const result = await runDiscordToolAction(request);
  sendJson(res, 200, result);
}

function handleApiHistory(res: ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get('sessionId') || 'web:default';
  const parsedLimit = parseInt(url.searchParams.get('limit') || '40', 10);
  const limit = Number.isNaN(parsedLimit) ? 40 : parsedLimit;
  const history = getGatewayHistory(sessionId, limit);
  sendJson(res, 200, { sessionId, history });
}

function handleApiProactivePull(res: ServerResponse, url: URL): void {
  const channelId = (url.searchParams.get('channelId') || '').trim();
  if (!channelId) {
    sendJson(res, 400, { error: 'Missing `channelId` query parameter.' });
    return;
  }
  const parsedLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
  const messages = claimQueuedProactiveMessages(channelId, limit);
  sendJson(res, 200, { channelId, messages });
}

function handleApiShutdown(res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    message: 'Gateway shutdown requested.',
  });
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 50);
}

export function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/health' && method === 'GET') {
      sendJson(res, 200, getGatewayStatus());
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!hasApiAuth(req)) {
        sendJson(res, 401, {
          error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
        });
        return;
      }

      void (async () => {
        try {
          if (pathname === '/api/status' && method === 'GET') {
            sendJson(res, 200, getGatewayStatus());
            return;
          }
          if (pathname === '/api/history' && method === 'GET') {
            handleApiHistory(res, url);
            return;
          }
          if (pathname === '/api/proactive/pull' && method === 'GET') {
            handleApiProactivePull(res, url);
            return;
          }
          if (pathname === '/api/admin/shutdown' && method === 'POST') {
            handleApiShutdown(res);
            return;
          }
          if (pathname === '/api/chat' && method === 'POST') {
            await handleApiChat(req, res);
            return;
          }
          if (pathname === '/api/command' && method === 'POST') {
            await handleApiCommand(req, res);
            return;
          }
          if (pathname === '/api/discord/action' && method === 'POST') {
            await handleApiDiscordAction(req, res);
            return;
          }
          sendJson(res, 404, { error: 'Not Found' });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: errorText });
        }
      })();
      return;
    }

    if (serveStatic(pathname, res)) return;
    sendText(res, 404, 'Not Found');
  });

  server.listen(HEALTH_PORT, HEALTH_HOST, () => {
    logger.info(
      { host: HEALTH_HOST, port: HEALTH_PORT },
      'Gateway HTTP server started',
    );
  });
}
