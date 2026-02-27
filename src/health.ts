import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';

import { HEALTH_HOST, HEALTH_PORT, WEB_API_TOKEN } from './config.js';
import {
  getGatewayHistory,
  getGatewayStatus,
  handleGatewayCommand,
  handleGatewayMessage,
  type GatewayCommandRequest,
  type GatewayChatRequest,
} from './gateway-service.js';
import { logger } from './logger.js';

const SITE_DIR = path.resolve(process.cwd(), 'site');
const MAX_REQUEST_BYTES = 1_000_000; // 1MB

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function hasApiAuth(req: IncomingMessage): boolean {
  if (!WEB_API_TOKEN) {
    return isLoopbackAddress(req.socket.remoteAddress);
  }
  const authHeader = req.headers.authorization || '';
  return authHeader === `Bearer ${WEB_API_TOKEN}`;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
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
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  return candidate;
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const filePath = resolveSiteFile(pathname === '/chat' ? '/chat.html' : pathname);
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(fs.readFileSync(filePath));
  return true;
}

async function handleApiChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as Partial<GatewayChatRequest>;

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
  const result = await handleGatewayMessage(chatRequest);
  sendJson(res, result.status === 'success' ? 200 : 500, result);
}

async function handleApiCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req) as Partial<GatewayCommandRequest>;
  const args = Array.isArray(body.args) ? body.args.map((value) => String(value)) : [];
  if (args.length === 0) {
    sendJson(res, 400, { error: 'Missing command. Provide non-empty `args` array.' });
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

function handleApiHistory(res: ServerResponse, url: URL): void {
  const sessionId = url.searchParams.get('sessionId') || 'web:default';
  const parsedLimit = parseInt(url.searchParams.get('limit') || '40', 10);
  const limit = Number.isNaN(parsedLimit) ? 40 : parsedLimit;
  const history = getGatewayHistory(sessionId, limit);
  sendJson(res, 200, { sessionId, history });
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
        sendJson(res, 401, { error: 'Unauthorized. Set `Authorization: Bearer <WEB_API_TOKEN>`.' });
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
          if (pathname === '/api/chat' && method === 'POST') {
            await handleApiChat(req, res);
            return;
          }
          if (pathname === '/api/command' && method === 'POST') {
            await handleApiCommand(req, res);
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
    logger.info({ host: HEALTH_HOST, port: HEALTH_PORT }, 'Gateway HTTP server started');
  });
}
