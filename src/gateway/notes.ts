/**
 * Notebook HTTP access stays inside a registered agent workspace and requires
 * explicit notes capabilities. It does not expose arbitrary filesystem paths
 * or execute a model turn when a person edits a page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAgentById } from '../agents/agent-registry.js';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { NOTES_PATH, NOTES_RUNTIME_PATH } from '../security/admin-rbac.js';
import { isRecord } from '../utils/type-guards.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { changeNotes, listNotes, readNote } from './notes-store.js';

export { NOTES_PATH, NOTES_RUNTIME_PATH };
export async function handleNotesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (
    !['GET', 'POST'].includes(method) ||
    (url.pathname === NOTES_RUNTIME_PATH && method !== 'POST')
  ) {
    res.setHeader(
      'Allow',
      url.pathname === NOTES_RUNTIME_PATH ? 'POST' : 'GET, POST',
    );
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  try {
    const agent = getAgentById(
      url.searchParams.get('agentId') ?? DEFAULT_AGENT_ID,
    );
    if (!agent || agent.archived)
      throw new GatewayRequestError(404, 'Hy workspace is unavailable.');
    const root = agentWorkspaceDir(agent.id);
    const id = url.searchParams.get('id');
    const body =
      method === 'POST'
        ? await readJsonBody(req, 6 * 1024 * 1024 + 4096)
        : null;
    const runtimeRead = url.pathname === NOTES_RUNTIME_PATH && isRecord(body);
    const result =
      runtimeRead && body.operation === 'list'
        ? listNotes(root)
        : runtimeRead && body.operation === 'read'
          ? readNote(
              root,
              body.id,
              typeof body.revision === 'string' ? body.revision : undefined,
            )
          : method === 'POST'
            ? changeNotes(root, body)
            : id
              ? readNote(
                  root,
                  id,
                  url.searchParams.get('revision') ?? undefined,
                )
              : listNotes(root);
    sendJson(res, 200, { ...result, scope: 'agent-notes', agentId: agent.id });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status =
      error instanceof GatewayRequestError
        ? error.statusCode
        : code === 'ENOENT'
          ? 404
          : ['EACCES', 'EPERM', 'ELOOP', 'EEXIST'].includes(code ?? '')
            ? 403
            : 500;
    sendJson(res, status, {
      error:
        error instanceof GatewayRequestError
          ? error.message
          : 'Could not open the notebook.',
    });
  }
}
