/**
 * Device authorization grants (the RFC 8628 shape): how a phone app gets its
 * own API token from this gateway without anyone typing a secret into it.
 *
 * A grant lives in memory for ten minutes and goes `pending → approved |
 * denied`, then is collected at most once. Approving needs an admin who may
 * create tokens; the client never names what it may do. The token is minted
 * when the client collects it, through the admin token service, so it is
 * scoped, audited, listed and revoked like any other `hck_` token.
 *
 * NOT a console login (`auth-token.ts`, the local session) and NOT the mobile
 * QR handoff, which moves a browser session to a phone's browser.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  type AdminRbacAction,
  isAdminActionAllowed,
} from '../security/admin-rbac.js';
import {
  type AdminTokenAuditContext,
  createGatewayAdminToken,
} from './gateway-admin-tokens.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export const DEVICE_CODE_PATH = '/api/device/code';
export const DEVICE_TOKEN_PATH = '/api/device/token';
const ADMIN_DEVICE_PREFIX = '/api/admin/devices/';
export const DEVICE_VERIFICATION_PATH = '/admin/credentials';

// 2026-09-30 (product owner): a paired phone chats, lists agents and opens the
// documents replies link to. It gets no admin, history or secret access; the
// same evening the owner let it read single replies in chats it started
// (`/api/chat/message` under `chat.send`), so reminders reach the phone.
export const DEVICE_TOKEN_ACTIONS = [
  'chat.send',
  'agents.read',
  'artifacts.read',
] as const satisfies readonly AdminRbacAction[];

// RFC 8628 §6.1 defaults: long enough to walk to a computer, short enough that
// a code shown on a screen is not worth copying.
const GRANT_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_SECONDS = 5;
// Starting a grant needs no credentials, so pending grants are capped.
const MAX_PENDING_GRANTS = 20;
const CLIENT_NAME_MAX_LENGTH = 80;
// Lowercase consonants and digits without look-alikes: 27^8, about 38 bits.
const USER_CODE_ALPHABET = 'bcdfghjkmnpqrstvwxz23456789';

interface DeviceGrant {
  deviceCode: string;
  userCode: string;
  clientName: string;
  sourceIp: string | null;
  expiresAt: number;
  lastPollAt: number;
  decision: { approved: true; audit: AdminTokenAuditContext } | null | false;
}

const grants = new Map<string, DeviceGrant>();

export interface DeviceGrantSummary {
  userCode: string;
  clientName: string;
  sourceIp: string | null;
  expiresAt: string;
}

function prune(now: number): void {
  for (const [deviceCode, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(deviceCode);
  }
}

function makeUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    if (i === 3) code += '-';
  }
  return code;
}

// People type what they read: capitals, spaces and a missing hyphen still match.
function normalizeUserCode(value: string): string {
  const compact = value.toLowerCase().replace(/[\s-]/g, '');
  return compact.length === 8
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : compact;
}

function findByUserCode(value: string, now: number): DeviceGrant {
  prune(now);
  const userCode = normalizeUserCode(value);
  for (const grant of grants.values()) {
    if (grant.userCode === userCode) return grant;
  }
  throw new GatewayRequestError(404, 'No device is waiting with this code.');
}

function summarize(grant: DeviceGrant): DeviceGrantSummary {
  return {
    userCode: grant.userCode,
    clientName: grant.clientName,
    sourceIp: grant.sourceIp,
    expiresAt: new Date(grant.expiresAt).toISOString(),
  };
}

export function startDeviceGrant(input: {
  clientName: unknown;
  sourceIp: string | null;
  origin: string;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  prune(now);
  if (grants.size >= MAX_PENDING_GRANTS) {
    throw new GatewayRequestError(
      429,
      'Too many devices are waiting for approval. Try again in a few minutes.',
    );
  }
  const clientName =
    typeof input.clientName === 'string' ? input.clientName.trim() : '';
  if (!clientName || clientName.length > CLIENT_NAME_MAX_LENGTH) {
    throw new GatewayRequestError(
      400,
      `\`client_name\` must be 1 to ${CLIENT_NAME_MAX_LENGTH} characters.`,
    );
  }
  let userCode = makeUserCode();
  while ([...grants.values()].some((grant) => grant.userCode === userCode)) {
    userCode = makeUserCode();
  }
  const grant: DeviceGrant = {
    deviceCode: randomBytes(32).toString('base64url'),
    userCode,
    clientName,
    sourceIp: input.sourceIp,
    expiresAt: now + GRANT_TTL_MS,
    lastPollAt: 0,
    decision: null,
  };
  grants.set(grant.deviceCode, grant);
  const verificationUri = `${input.origin}${DEVICE_VERIFICATION_PATH}?tab=devices`;
  return {
    device_code: grant.deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}&code=${userCode}`,
    expires_in: GRANT_TTL_MS / 1000,
    interval: POLL_INTERVAL_SECONDS,
  };
}

// RFC 8628 §3.5: every answer but the token is a 400 with an `error` code.
export function pollDeviceGrant(
  deviceCode: unknown,
  now = Date.now(),
): { status: number; body: Record<string, string> } {
  prune(now);
  const grant =
    typeof deviceCode === 'string' ? grants.get(deviceCode) : undefined;
  if (!grant) return { status: 400, body: { error: 'expired_token' } };
  if (grant.decision === false) {
    grants.delete(grant.deviceCode);
    return { status: 400, body: { error: 'access_denied' } };
  }
  if (!grant.decision) {
    const early = now - grant.lastPollAt < POLL_INTERVAL_SECONDS * 1000;
    grant.lastPollAt = now;
    return {
      status: 400,
      body: { error: early ? 'slow_down' : 'authorization_pending' },
    };
  }
  grants.delete(grant.deviceCode);
  const created = createGatewayAdminToken({
    body: {
      label: `Device: ${grant.clientName}`,
      actions: [...DEVICE_TOKEN_ACTIONS],
    },
    audit: grant.decision.audit,
  });
  return {
    status: 200,
    body: { access_token: created.token, token_type: 'Bearer' },
  };
}

export function describeDeviceGrant(
  userCode: string,
  now = Date.now(),
): DeviceGrantSummary {
  return summarize(findByUserCode(userCode, now));
}

export function decideDeviceGrant(input: {
  userCode: string;
  approve: boolean;
  audit: AdminTokenAuditContext;
  now?: number;
}): DeviceGrantSummary {
  const grant = findByUserCode(input.userCode, input.now ?? Date.now());
  if (grant.decision !== null) {
    throw new GatewayRequestError(409, 'This device was already answered.');
  }
  grant.decision = input.approve
    ? { approved: true, audit: input.audit }
    : false;
  return summarize(grant);
}

export function parseAdminDeviceUserCode(pathname: string): string | null {
  if (!pathname.startsWith(ADMIN_DEVICE_PREFIX)) return null;
  const encoded = pathname.slice(ADMIN_DEVICE_PREFIX.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new GatewayRequestError(400, 'Invalid device code in request path.');
  }
}

/**
 * `GET` shows who is asking; `POST {approve}` answers. Approving mints a token
 * later, so it takes what creating a token takes, and an API token cannot
 * approve another device.
 */
export async function handleAdminDeviceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  userCode: string,
  authContext: { kind: string; payload: Record<string, unknown> | null },
  audit: AdminTokenAuditContext,
): Promise<void> {
  if (
    authContext.kind === 'apiToken' ||
    !isAdminActionAllowed(authContext.payload, 'admin.tokens.create')
  ) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, { device: describeDeviceGrant(userCode) });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  const body = await readJsonBody(req);
  const approve = (body as { approve?: unknown } | null)?.approve;
  if (typeof approve !== 'boolean') {
    throw new GatewayRequestError(400, '`approve` must be true or false.');
  }
  sendJson(res, 200, {
    device: decideDeviceGrant({ userCode, approve, audit }),
  });
}

/** The two routes a device calls before it has any credential. Never rejects. */
export async function handleDeviceGrantRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  origin: string,
): Promise<void> {
  try {
    await answerDeviceGrantRoute(req, res, pathname, origin);
  } catch (err) {
    if (res.writableEnded) return;
    const statusCode =
      err instanceof GatewayRequestError ? err.statusCode : 500;
    sendJson(res, statusCode, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function answerDeviceGrantRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  origin: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  const body = await readJsonBody(req);
  const fields = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >;
  if (pathname === DEVICE_CODE_PATH) {
    sendJson(
      res,
      200,
      startDeviceGrant({
        clientName: fields.client_name,
        sourceIp: req.socket.remoteAddress || null,
        origin,
      }),
    );
    return;
  }
  const result = pollDeviceGrant(fields.device_code);
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, result.status, result.body);
}

export function resetDeviceGrantsForTests(): void {
  grants.clear();
}
