/**
 * Worker credentials — the only gateway credential a worker process, and the
 * tools it runs, ever hold.
 *
 * Each worker gets its own random token at spawn, bound to its agent and, once
 * a session claims the worker, to that session. The gateway accepts it on
 * WORKER_RUNTIME_ROUTES only and takes the caller's `agentId` and `sessionId`
 * from the binding, never from the request body. Tokens live in gateway
 * memory and die with the worker or the gateway.
 *
 * NOT the operator's GATEWAY_API_TOKEN or the scoped `hck_` API tokens
 * (`api-tokens.ts`); neither may enter a sandbox.
 */
import { createHash, randomBytes } from 'node:crypto';
import { SHELL_RUNTIME_ENV_PATH } from '../../container/shared/shell-runtime-env.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { isRecord } from '../utils/type-guards.js';

const WORKER_CREDENTIAL_PREFIX = 'hcw_';

export interface WorkerCredentialBinding {
  agentId: string;
  /** Null while the worker waits unclaimed in the warm pool. */
  sessionId: string | null;
}

interface WorkerRuntimeRoute {
  /** The body's `sessionId` names the calling session. */
  callerSession: boolean;
  /** Ids the gateway assigns, which a worker may not choose. */
  gatewayAssigned?: readonly string[];
}

// The routes worker-side code calls: container/src tools and bundled skill
// helpers (which use /api/http/request only). Every other route rejects a
// worker credential. On the escalation routes `sessionId` is an escalation
// id, not a chat session; their handlers check that the caller's agent owns it.
const WORKER_RUNTIME_ROUTES: Readonly<Record<string, WorkerRuntimeRoute>> = {
  'POST /api/http/request': { callerSession: true },
  'POST /api/secret/inject': { callerSession: true },
  'POST /api/browser/tool': { callerSession: true },
  'POST /api/message/action': { callerSession: true },
  'POST /api/plugin/tool': { callerSession: true },
  'POST /api/scheduler/task': { callerSession: true },
  'POST /api/interactive-escalations': {
    callerSession: false,
    gatewayAssigned: ['sessionId', 'approvalId'],
  },
  'POST /api/interactive-escalations/consume': { callerSession: false },
  [`POST ${SHELL_RUNTIME_ENV_PATH}`]: { callerSession: false },
};

const bindings = new Map<string, WorkerCredentialBinding>();

function credentialKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueWorkerCredential(
  binding: WorkerCredentialBinding,
): string {
  const token = `${WORKER_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  bindings.set(credentialKey(token), { ...binding });
  return token;
}

export function bindWorkerCredentialSession(
  token: string,
  sessionId: string,
): void {
  const binding = bindings.get(credentialKey(token));
  if (!binding) return;
  if (binding.sessionId && binding.sessionId !== sessionId) {
    throw new Error('Worker credential is already bound to another session.');
  }
  binding.sessionId = sessionId;
}

export function revokeWorkerCredential(token: string): void {
  bindings.delete(credentialKey(token));
}

export function resolveWorkerCredential(
  token: string,
): Readonly<WorkerCredentialBinding> | null {
  if (!token.startsWith(WORKER_CREDENTIAL_PREFIX)) return null;
  return bindings.get(credentialKey(token)) ?? null;
}

export function isWorkerRuntimeRoute(
  method: string,
  pathname: string,
): boolean {
  return Object.hasOwn(WORKER_RUNTIME_ROUTES, `${method} ${pathname}`);
}

function assertSameCaller(claimed: unknown, bound: string): void {
  if (claimed === undefined || claimed === null || claimed === '') return;
  if (claimed !== bound) {
    throw new GatewayRequestError(
      403,
      'Worker credentials act only for their own agent and session.',
    );
  }
}

/**
 * Returns `body` with the caller's identity taken from `worker`; without a
 * worker credential the body passes through unchanged.
 */
export function bindWorkerRequestBody(
  body: unknown,
  worker: Readonly<WorkerCredentialBinding> | null,
  method: string,
  pathname: string,
): unknown {
  if (!worker) return body;
  const route = WORKER_RUNTIME_ROUTES[`${method} ${pathname}`];
  if (!route) throw new GatewayRequestError(403, 'Forbidden.');
  if (!isRecord(body)) {
    throw new GatewayRequestError(400, 'Request body must be a JSON object.');
  }
  for (const field of route.gatewayAssigned ?? []) {
    if (body[field] !== undefined) {
      throw new GatewayRequestError(403, `Workers may not set \`${field}\`.`);
    }
  }
  assertSameCaller(body.agentId, worker.agentId);
  if (!route.callerSession) return { ...body, agentId: worker.agentId };
  if (!worker.sessionId) throw new GatewayRequestError(403, 'Forbidden.');
  assertSameCaller(body.sessionId, worker.sessionId);
  return { ...body, agentId: worker.agentId, sessionId: worker.sessionId };
}
