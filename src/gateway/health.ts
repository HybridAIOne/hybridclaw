import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { runDiscordToolAction } from '../channels/discord/runtime.js';
import {
  type DiscordToolActionRequest,
  normalizeDiscordToolAction,
} from '../channels/discord/tool-actions.js';
import {
  DATA_DIR,
  GATEWAY_API_TOKEN,
  HEALTH_HOST,
  HEALTH_PORT,
  WEB_API_TOKEN,
} from '../config/config.js';
import type {
  RuntimeConfig,
  RuntimeDiscordChannelConfig,
} from '../config/runtime-config.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { logger } from '../logger.js';
import { claimQueuedProactiveMessages } from '../memory/db.js';
import type { ToolProgressEvent } from '../types.js';
import {
  deleteGatewayAdminSession,
  type GatewayChatRequest,
  type GatewayCommandRequest,
  getGatewayAdminAudit,
  getGatewayAdminChannels,
  getGatewayAdminConfig,
  getGatewayAdminMcp,
  getGatewayAdminModels,
  getGatewayAdminOverview,
  getGatewayAdminScheduler,
  getGatewayAdminSessions,
  getGatewayAdminSkills,
  getGatewayAdminTools,
  getGatewayAgents,
  getGatewayHistory,
  getGatewayStatus,
  handleGatewayCommand,
  handleGatewayMessage,
  removeGatewayAdminChannel,
  removeGatewayAdminMcpServer,
  removeGatewayAdminSchedulerJob,
  saveGatewayAdminConfig,
  saveGatewayAdminModels,
  setGatewayAdminSchedulerJobPaused,
  setGatewayAdminSkillEnabled,
  upsertGatewayAdminChannel,
  upsertGatewayAdminMcpServer,
  upsertGatewayAdminSchedulerJob,
} from './gateway-service.js';
import type { GatewayChatRequestBody } from './gateway-types.js';

const SITE_DIR = resolveInstallPath('docs');
const CONSOLE_DIST_DIR = resolveInstallPath('console', 'dist');
const AGENT_ARTIFACT_ROOT = path.resolve(path.join(DATA_DIR, 'agents'));
const DISCORD_MEDIA_CACHE_DIR = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);
const MAX_REQUEST_BYTES = 1_000_000; // 1MB

const SITE_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const SAFE_INLINE_ARTIFACT_MIME_TYPES: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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

function isRuntimeDiscordChannelConfig(
  value: unknown,
): value is RuntimeDiscordChannelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === 'off' || mode === 'mention' || mode === 'free';
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

function hasQueryToken(url: URL): boolean {
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return false;
  if (WEB_API_TOKEN && token === WEB_API_TOKEN) return true;
  return token === GATEWAY_API_TOKEN;
}

function hasApiAuth(
  req: IncomingMessage,
  url?: URL,
  opts?: { allowQueryToken?: boolean },
): boolean {
  const authHeader = req.headers.authorization || '';
  const gatewayTokenMatch =
    Boolean(GATEWAY_API_TOKEN) && authHeader === `Bearer ${GATEWAY_API_TOKEN}`;
  if (opts?.allowQueryToken && url && hasQueryToken(url)) return true;

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

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolvePathForContainmentCheck(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveArtifactFile(url: URL): string | null {
  const raw = (url.searchParams.get('path') || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (
    !isWithinRoot(
      realFilePath,
      resolvePathForContainmentCheck(AGENT_ARTIFACT_ROOT),
    ) &&
    !isWithinRoot(
      realFilePath,
      resolvePathForContainmentCheck(DISCORD_MEDIA_CACHE_DIR),
    )
  ) {
    return null;
  }
  if (!fs.existsSync(realFilePath) || !fs.statSync(realFilePath).isFile())
    return null;
  return realFilePath;
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
  return resolveStaticFile(
    SITE_DIR,
    pathname === '/' ? '/index.html' : pathname,
  );
}

function resolveStaticFile(rootDir: string, pathname: string): string | null {
  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const candidate = path.resolve(rootDir, `.${normalized}`);
  if (!candidate.startsWith(rootDir)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile())
    return null;
  return candidate;
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveSiteFile(
    pathname === '/chat'
      ? '/chat.html'
      : pathname === '/agents'
        ? '/agents.html'
        : pathname,
  );
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(fs.readFileSync(filePath));
  return true;
}

function resolveConsoleFile(pathname: string): string | null {
  const subPath = pathname.replace(/^\/admin/, '') || '/index.html';
  const directFile = resolveStaticFile(CONSOLE_DIST_DIR, subPath);
  if (directFile) return directFile;
  return resolveStaticFile(CONSOLE_DIST_DIR, '/index.html');
}

function serveConsole(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveConsoleFile(pathname);
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SITE_MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Cache-Control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
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
  logger.debug(
    {
      sessionId: chatRequest.sessionId,
      channelId: chatRequest.channelId,
      guildId: chatRequest.guildId,
      model: chatRequest.model || null,
      stream: wantsStream,
      contentLength: chatRequest.content.length,
    },
    'Received gateway API chat request',
  );

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
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
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
    filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
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

function handleApiAgents(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAgents());
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

function handleApiAdminOverview(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminOverview());
}

function handleApiAdminSessions(res: ServerResponse): void {
  sendJson(res, 200, { sessions: getGatewayAdminSessions() });
}

function handleApiAdminSessionDelete(res: ServerResponse, url: URL): void {
  const sessionId = (url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing `sessionId` query parameter.' });
    return;
  }
  sendJson(res, 200, deleteGatewayAdminSession(sessionId));
}

async function handleApiAdminChannels(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminChannels());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const guildId = (url.searchParams.get('guildId') || '').trim();
    const channelId = (url.searchParams.get('channelId') || '').trim();
    sendJson(res, 200, removeGatewayAdminChannel({ guildId, channelId }));
    return;
  }

  const body = (await readJsonBody(req)) as {
    guildId?: string;
    channelId?: string;
    config?: Record<string, unknown>;
  };
  if (
    typeof body.guildId !== 'string' ||
    typeof body.channelId !== 'string' ||
    !isRuntimeDiscordChannelConfig(body.config)
  ) {
    sendJson(res, 400, {
      error:
        'Expected `guildId`, `channelId`, and object `config` with `mode` set to off, mention, or free.',
    });
    return;
  }

  sendJson(
    res,
    200,
    upsertGatewayAdminChannel({
      guildId: body.guildId,
      channelId: body.channelId,
      config: body.config,
    }),
  );
}

async function handleApiAdminConfig(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminConfig());
    return;
  }

  const body = (await readJsonBody(req)) as { config?: unknown };
  if (
    !body.config ||
    typeof body.config !== 'object' ||
    Array.isArray(body.config)
  ) {
    sendJson(res, 400, { error: 'Expected object `config` in request body.' });
    return;
  }

  sendJson(res, 200, saveGatewayAdminConfig(body.config as RuntimeConfig));
}

async function handleApiAdminModels(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, await getGatewayAdminModels());
    return;
  }

  const body = (await readJsonBody(req)) as {
    defaultModel?: unknown;
    hybridaiModels?: unknown;
    codexModels?: unknown;
  };
  sendJson(res, 200, await saveGatewayAdminModels(body));
}

async function handleApiAdminScheduler(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminScheduler());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const source =
      (url.searchParams.get('source') || '').trim().toLowerCase() === 'task'
        ? 'task'
        : 'config';
    const rawId =
      source === 'task'
        ? (url.searchParams.get('taskId') || '').trim()
        : (url.searchParams.get('jobId') || '').trim();
    const jobId = (url.searchParams.get('jobId') || '').trim();
    sendJson(res, 200, removeGatewayAdminSchedulerJob(rawId || jobId, source));
    return;
  }

  if ((req.method || 'GET') === 'POST') {
    const body = (await readJsonBody(req)) as {
      jobId?: unknown;
      taskId?: unknown;
      source?: unknown;
      action?: unknown;
    };
    const source =
      String(body.source || '')
        .trim()
        .toLowerCase() === 'task'
        ? 'task'
        : 'config';
    const jobId = String(
      source === 'task' ? body.taskId || '' : body.jobId || '',
    ).trim();
    const action = String(body.action || '')
      .trim()
      .toLowerCase();
    if (action !== 'pause' && action !== 'resume') {
      sendJson(res, 400, {
        error: 'Expected scheduler action `pause` or `resume`.',
      });
      return;
    }
    sendJson(
      res,
      200,
      setGatewayAdminSchedulerJobPaused({
        jobId,
        paused: action === 'pause',
        source,
      }),
    );
    return;
  }

  const body = (await readJsonBody(req)) as { job?: unknown };
  sendJson(res, 200, upsertGatewayAdminSchedulerJob({ job: body.job }));
}

async function handleApiAdminMcp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminMcp());
    return;
  }

  if ((req.method || 'GET') === 'DELETE') {
    const name = (url.searchParams.get('name') || '').trim();
    sendJson(res, 200, removeGatewayAdminMcpServer(name));
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
    config?: unknown;
  };
  sendJson(
    res,
    200,
    upsertGatewayAdminMcpServer({
      name: String(body.name || ''),
      config: body.config,
    }),
  );
}

function handleApiAdminAudit(res: ServerResponse, url: URL): void {
  const parsedLimit = parseInt(url.searchParams.get('limit') || '60', 10);
  const limit = Number.isNaN(parsedLimit) ? 60 : parsedLimit;
  sendJson(
    res,
    200,
    getGatewayAdminAudit({
      query: url.searchParams.get('query') || '',
      sessionId: url.searchParams.get('sessionId') || '',
      eventType: url.searchParams.get('eventType') || '',
      limit,
    }),
  );
}

function handleApiAdminTools(res: ServerResponse): void {
  sendJson(res, 200, getGatewayAdminTools());
}

async function handleApiAdminSkills(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.method || 'GET') === 'GET') {
    sendJson(res, 200, getGatewayAdminSkills());
    return;
  }

  const body = (await readJsonBody(req)) as {
    name?: unknown;
    enabled?: unknown;
  };
  if (typeof body.enabled !== 'boolean') {
    sendJson(res, 400, {
      error: 'Expected boolean `enabled` in request body.',
    });
    return;
  }
  sendJson(
    res,
    200,
    setGatewayAdminSkillEnabled({
      name: String(body.name || ''),
      enabled: body.enabled,
    }),
  );
}

function handleApiEvents(req: IncomingMessage, res: ServerResponse): void {
  const sendEvent = (event: string, payload: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const sendSnapshot = (): void => {
    sendEvent('overview', getGatewayAdminOverview());
    sendEvent('status', getGatewayStatus());
  };

  sendSnapshot();
  const timer = setInterval(sendSnapshot, 10_000);

  req.on('close', () => {
    clearInterval(timer);
    if (!res.writableEnded) res.end();
  });
}

function handleApiArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (!hasApiAuth(req, url, { allowQueryToken: true })) {
    sendJson(res, 401, {
      error:
        'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>` or pass `?token=<WEB_API_TOKEN>`.',
    });
    return;
  }

  const filePath = resolveArtifactFile(url);
  if (!filePath) {
    sendJson(res, 404, { error: 'Artifact not found.' });
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError) {
      const code = (statError as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        sendJson(res, 404, { error: 'Artifact not found.' });
        return;
      }
      logger.warn(
        { filePath, error: statError },
        'Failed to stat artifact before streaming',
      );
      sendJson(res, 500, { error: 'Failed to read artifact.' });
      return;
    }

    if (!stats.isFile()) {
      sendJson(res, 404, { error: 'Artifact not found.' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const inlineMimeType = SAFE_INLINE_ARTIFACT_MIME_TYPES[ext];
    const mimeType = inlineMimeType || 'application/octet-stream';
    const dispositionType = inlineMimeType ? 'inline' : 'attachment';
    const filename = path.basename(filePath);
    const stream = fs.createReadStream(filePath);

    stream.on('open', () => {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': `${dispositionType}; filename="${filename.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
        'Content-Length': String(stats.size),
        'X-Content-Type-Options': 'nosniff',
        ...(dispositionType === 'attachment'
          ? {
              'Content-Security-Policy': "sandbox; default-src 'none'",
            }
          : {}),
      });
    });

    stream.on('data', (chunk) => {
      res.write(chunk);
    });

    stream.on('end', () => {
      if (!res.writableEnded) res.end();
    });

    stream.on('error', (error) => {
      logger.warn({ filePath, error }, 'Failed to stream artifact');
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Failed to read artifact.' });
        return;
      }
      if (typeof res.destroy === 'function') {
        res.destroy(error);
        return;
      }
      if (!res.writableEnded) res.end();
    });
  });
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
      if (pathname === '/api/artifact' && method === 'GET') {
        handleApiArtifact(req, res, url);
        return;
      }

      if (
        !hasApiAuth(req, url, {
          allowQueryToken: pathname === '/api/events',
        })
      ) {
        sendJson(res, 401, {
          error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.',
        });
        return;
      }

      void (async () => {
        try {
          if (pathname === '/api/events' && method === 'GET') {
            handleApiEvents(req, res);
            return;
          }
          if (pathname === '/api/status' && method === 'GET') {
            sendJson(res, 200, getGatewayStatus());
            return;
          }
          if (pathname === '/api/admin/overview' && method === 'GET') {
            handleApiAdminOverview(res);
            return;
          }
          if (
            pathname === '/api/admin/models' &&
            (method === 'GET' || method === 'PUT')
          ) {
            await handleApiAdminModels(req, res);
            return;
          }
          if (pathname === '/api/admin/sessions' && method === 'GET') {
            handleApiAdminSessions(res);
            return;
          }
          if (pathname === '/api/admin/sessions' && method === 'DELETE') {
            handleApiAdminSessionDelete(res, url);
            return;
          }
          if (
            pathname === '/api/admin/scheduler' &&
            (method === 'GET' ||
              method === 'PUT' ||
              method === 'DELETE' ||
              method === 'POST')
          ) {
            await handleApiAdminScheduler(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/channels' &&
            (method === 'GET' || method === 'PUT' || method === 'DELETE')
          ) {
            await handleApiAdminChannels(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/mcp' &&
            (method === 'GET' || method === 'PUT' || method === 'DELETE')
          ) {
            await handleApiAdminMcp(req, res, url);
            return;
          }
          if (
            pathname === '/api/admin/config' &&
            (method === 'GET' || method === 'PUT')
          ) {
            await handleApiAdminConfig(req, res);
            return;
          }
          if (pathname === '/api/admin/audit' && method === 'GET') {
            handleApiAdminAudit(res, url);
            return;
          }
          if (pathname === '/api/admin/tools' && method === 'GET') {
            handleApiAdminTools(res);
            return;
          }
          if (
            pathname === '/api/admin/skills' &&
            (method === 'GET' || method === 'PUT')
          ) {
            await handleApiAdminSkills(req, res);
            return;
          }
          if (pathname === '/api/history' && method === 'GET') {
            handleApiHistory(res, url);
            return;
          }
          if (pathname === '/api/agents' && method === 'GET') {
            handleApiAgents(res);
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

    if (pathname.startsWith('/admin')) {
      if (serveConsole(pathname, res)) return;
      sendText(
        res,
        503,
        'Admin console assets not found. Run `npm run build:console`.',
      );
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
