/**
 * HTTP side of website sign-ins (`security/browser-sign-ins.ts`).
 *
 * `/api/browser/sign-in` is the agent's: the container's `browser_sign_in`
 * asks, with the gateway token, which store names hold the sign-in for the
 * page's host. It never returns a value; the container injects each one
 * through `/api/secret/inject` like `browser_secret_type`.
 *
 * `/api/sign-ins` is the user's: a client lists sites, saves one (the Hy app's
 * sign-in sheet), or forgets one. It takes cleartext in and never gives any
 * back. Every save and delete is audited without values.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeAuditRunId, recordAuditEvent } from '../audit/audit-events.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  deleteBrowserSignIn,
  findBrowserSignIn,
  listBrowserSignIns,
  normalizeBrowserSignInHost,
  saveBrowserSignIn,
} from '../security/browser-sign-ins.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';

export const BROWSER_SIGN_IN_LOOKUP_PATH = '/api/browser/sign-in';
export const SIGN_INS_PATH = '/api/sign-ins';

export interface SignInAuditContext {
  actor?: string | null;
  sourceIp?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireHost(raw: unknown): string {
  const host = normalizeBrowserSignInHost(raw);
  if (!host) {
    throw new GatewayRequestError(400, 'Expected the site as a hostname.');
  }
  return host;
}

function recordSignInAudit(params: {
  type: 'browser.sign_in_saved' | 'browser.sign_in_removed';
  host: string;
  audit: SignInAuditContext;
  username?: boolean;
}): void {
  recordAuditEvent({
    sessionId: params.audit.actor || 'sign-ins',
    runId: makeAuditRunId('sign-in'),
    event: {
      type: params.type,
      host: params.host,
      actor: params.audit.actor || null,
      sourceIp: params.audit.sourceIp || null,
      ...(params.username === undefined ? {} : { username: params.username }),
    },
  });
}

export async function handleApiBrowserSignInLookup(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = requireHost(asRecord(await readJsonBody(req)).host);
  const signIn = findBrowserSignIn(host);
  sendJson(
    res,
    200,
    signIn ? { saved: true, ...signIn } : { saved: false, host },
  );
}

export async function handleApiSignIns(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  audit: SignInAuditContext,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const method = (req.method || 'GET').toUpperCase();
  if (pathname === SIGN_INS_PATH && method === 'GET') {
    sendJson(res, 200, { signIns: listBrowserSignIns() });
    return;
  }
  if (pathname === SIGN_INS_PATH && method === 'POST') {
    const body = asRecord(await readJsonBody(req));
    const host = requireHost(body.host);
    let signIn: ReturnType<typeof saveBrowserSignIn>;
    try {
      signIn = saveBrowserSignIn({
        host,
        username: body.username,
        password: body.password,
      });
    } catch (error) {
      throw new GatewayRequestError(
        400,
        error instanceof Error ? error.message : 'The sign-in was not saved.',
      );
    }
    recordSignInAudit({
      type: 'browser.sign_in_saved',
      host,
      audit,
      username: Boolean(signIn.usernameSecret),
    });
    sendJson(res, 200, { host, username: Boolean(signIn.usernameSecret) });
    return;
  }
  if (pathname.startsWith(`${SIGN_INS_PATH}/`) && method === 'DELETE') {
    let rawHost = '';
    try {
      rawHost = decodeURIComponent(pathname.slice(SIGN_INS_PATH.length + 1));
    } catch {
      // A malformed escape is not a hostname either.
    }
    const host = requireHost(rawHost);
    if (!deleteBrowserSignIn(host)) {
      throw new GatewayRequestError(404, `No sign-in is saved for ${host}.`);
    }
    recordSignInAudit({ type: 'browser.sign_in_removed', host, audit });
    sendJson(res, 200, { host, removed: true });
    return;
  }
  throw new GatewayRequestError(405, 'Method not allowed.');
}
