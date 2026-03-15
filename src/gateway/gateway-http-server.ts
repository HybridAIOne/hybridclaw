import http from 'node:http';

import { HEALTH_HOST, HEALTH_PORT } from '../config/config.js';
import { logger } from '../logger.js';
import {
  handleApiAdminAgents,
  handleApiAdminAudit,
  handleApiAdminChannels,
  handleApiAdminConfig,
  handleApiAdminMcp,
  handleApiAdminModels,
  handleApiAdminOverview,
  handleApiAdminScheduler,
  handleApiAdminSessionDelete,
  handleApiAdminSessions,
  handleApiAdminSkills,
  handleApiAdminTools,
  handleApiEvents,
} from './gateway-http-admin-routes.js';
import { handleApiArtifact } from './gateway-http-artifact-routes.js';
import { handleApiChat } from './gateway-http-chat-routes.js';
import {
  handleApiAgents,
  handleApiCommand,
  handleApiHistory,
  handleApiMessageAction,
  handleApiProactivePull,
  handleApiShutdown,
} from './gateway-http-command-routes.js';
import { hasApiAuth, sendJson, sendText } from './gateway-http-common.js';
import { serveConsole, serveStatic } from './gateway-http-static-routes.js';
import { getGatewayStatus } from './gateway-service.js';
import { handleHealthEndpoint } from './health-endpoint.js';

async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method || 'GET';
  const pathname = url.pathname;

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
    (pathname === '/api/admin/agents' &&
      (method === 'GET' || method === 'POST')) ||
    (pathname.startsWith('/api/admin/agents/') &&
      (method === 'PUT' || method === 'DELETE'))
  ) {
    await handleApiAdminAgents(req, res, url);
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
  if (
    (pathname === '/api/message/action' ||
      pathname === '/api/discord/action') &&
    method === 'POST'
  ) {
    await handleApiMessageAction(req, res);
    return;
  }
  sendJson(res, 404, { error: 'Not Found' });
}

function handleGatewayHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (handleHealthEndpoint(pathname, method, res)) {
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

    void handleApiRequest(req, res, url).catch((error: unknown) => {
      const errorText = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: errorText });
    });
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
}

export function startGatewayHttpServer(): void {
  const server = http.createServer(handleGatewayHttpRequest);
  server.listen(HEALTH_PORT, HEALTH_HOST, () => {
    logger.info(
      { host: HEALTH_HOST, port: HEALTH_PORT },
      'Gateway HTTP server started',
    );
  });
}
