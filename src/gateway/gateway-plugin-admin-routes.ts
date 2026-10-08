/**
 * Gateway side of plugin admin routes: resolves the RBAC action for, and
 * dispatches, `/api/admin/<pluginId>/...` requests that no core route owns.
 *
 * Both functions read the same loaded-plugin table, so the action the HTTP
 * auth gate enforces is the one the dispatched handler was registered with;
 * an unregistered path stays unmapped and is denied to scoped callers.
 * NOT the authenticator: callers must authenticate and enforce
 * `resolvePluginAdminRouteAction` before `handleGatewayPluginAdminRoute`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebhookHttpError } from '../channels/webhook-http.js';
import { logger } from '../logger.js';
import { matchLoadedPluginAdminRoute } from '../plugins/plugin-manager.js';
import type { PluginLogger } from '../plugins/plugin-types.js';
import type { AdminRbacAction } from '../security/admin-rbac.js';
import { sendJson } from './gateway-http-utils.js';

export function resolvePluginAdminRouteAction(
  pathname: string,
  method: string,
): AdminRbacAction | null {
  const match = matchLoadedPluginAdminRoute(method, pathname);
  return match?.kind === 'route' ? match.entry.route.rbacAction : null;
}

/** Returns false when no plugin owns the path, so the caller answers 404. */
export async function handleGatewayPluginAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = matchLoadedPluginAdminRoute(req.method || 'GET', url.pathname);
  if (!match) return false;
  if (match.kind === 'method-not-allowed') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  }
  if (match.kind === 'bad-path') {
    sendJson(res, 400, { error: 'Invalid path parameter.' });
    return true;
  }
  const { entry, params } = match;
  try {
    await entry.route.handler({
      req,
      res,
      url,
      params,
      pluginId: entry.pluginId,
      logger: logger.child({
        pluginId: entry.pluginId,
        adminRoute: entry.route.path,
      }) as PluginLogger,
    });
  } catch (error) {
    if (!(error instanceof WebhookHttpError)) throw error;
    sendJson(res, error.statusCode, { error: error.message });
    return true;
  }
  if (!res.writableEnded) {
    if (!res.headersSent) res.statusCode = 204;
    res.end();
  }
  return true;
}
