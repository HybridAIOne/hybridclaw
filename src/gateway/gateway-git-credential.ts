import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GITHUB_ACCESS_TOKEN_SECRET,
  resolveGitHubConnectorAccessToken,
} from '../auth/github-connector-auth.js';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import { normalizeSecretString as normalizeString } from '../security/secret-normalization.js';
import { resolveGitHubConnectorTokenOrThrow } from './gateway-http-proxy.js';
import { readJsonBody, sendJson } from './gateway-http-utils.js';
import { resolveStoredSecretForInjection } from './gateway-secret-injection.js';

/** Stored-secret fallback when the HybridAI GitHub connector is not connected. */
export const GITHUB_STORED_TOKEN_SECRET = 'GH_TOKEN';

/**
 * Username git sends alongside the token. GitHub accepts any non-empty
 * username for OAuth and installation tokens; `x-access-token` is the
 * documented convention for both.
 */
const GITHUB_GIT_USERNAME = 'x-access-token';

type ApiGitCredentialBody = {
  protocol?: unknown;
  host?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
};

export async function resolveGitHubGitCredential(params: {
  protocol: string;
  host: string;
  sessionId?: string;
  agentId?: string;
}): Promise<{ username: string; password: string; source: string }> {
  const protocol = params.protocol.toLowerCase();
  const host = params.host.toLowerCase();
  if (protocol !== 'https') {
    throw new GatewayRequestError(
      400,
      'Git credentials are only issued for https remotes.',
    );
  }
  if (host !== 'github.com') {
    throw new GatewayRequestError(
      403,
      `Git credentials are not available for host ${host || '(empty)'}.`,
    );
  }

  const context = {
    sessionId: params.sessionId,
    agentId: params.agentId,
    host,
  };

  const connectorToken = await resolveGitHubConnectorAccessToken();
  if (connectorToken) {
    const password = await resolveGitHubConnectorTokenOrThrow(
      GITHUB_ACCESS_TOKEN_SECRET,
      context,
    );
    return {
      username: GITHUB_GIT_USERNAME,
      password,
      source: GITHUB_ACCESS_TOKEN_SECRET,
    };
  }

  if (readStoredRuntimeSecret(GITHUB_STORED_TOKEN_SECRET)) {
    const password = resolveStoredSecretForInjection({
      secretName: GITHUB_STORED_TOKEN_SECRET,
      sessionId: params.sessionId,
      agentId: params.agentId,
      sinkKind: 'http',
      host,
    });
    return {
      username: GITHUB_GIT_USERNAME,
      password,
      source: GITHUB_STORED_TOKEN_SECRET,
    };
  }

  throw new GatewayRequestError(
    404,
    'No GitHub credentials available. Connect GitHub under Admin → Connectors, or store a token with `/secret set GH_TOKEN <token>`.',
  );
}

export async function handleApiGitCredential(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as ApiGitCredentialBody;
  const credential = await resolveGitHubGitCredential({
    protocol: normalizeString(body.protocol),
    host: normalizeString(body.host),
    sessionId: normalizeString(body.sessionId) || undefined,
    agentId: normalizeString(body.agentId) || undefined,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  // Gateway-token-only container endpoint; the cleartext goes straight to the
  // git credential helper and is registered with the leak scanner upstream.
  sendJson(res, 200, {
    ok: true,
    username: credential.username,
    password: credential.password,
    source: credential.source,
  });
}
