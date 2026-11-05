/**
 * `GH_TOKEN` for shell tools: the GitHub account the user connected to their
 * HybridAI account, so plain `git` and `gh` work against github.com. Any
 * failure yields no token, never a failed shell command, and a scoped chat
 * gets one only when its scope lists the `github` connector.
 *
 * NOT the HybridAI connector MCP tools (`src/mcp/hybridai-connectors.ts`),
 * which call GitHub on the platform side and never see the token.
 */
import { readHybridAIApiKey } from '../auth/hybridai-auth.js';
import { HYBRIDAI_BASE_URL } from '../config/config.js';
import { logger } from '../logger.js';
import type { RuntimeScope } from '../scopes/scope-runtime-auth.js';
import { getScope } from '../scopes/scope-store.js';
import { isRecord } from '../utils/type-guards.js';

const GIT_CREDENTIAL_PATH = '/api/v1/connectors/github/git-credential';
// 30 s (engineering choice, 2026-11-05): every bash call asks for shell env,
// and the platform hands out tokens with at least 60 s left, so a cached one
// never expires while reused. Misses (not connected, errors) recheck after 60 s.
const TOKEN_TTL_MS = 30_000;
const MISS_TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

let cached: { apiKey: string; token: string | null; expiresAt: number } | null =
  null;
let inFlight: Promise<string | null> | null = null;

async function fetchToken(apiKey: string): Promise<string | null> {
  let token: string | null = null;
  try {
    const response = await fetch(
      `${(HYBRIDAI_BASE_URL || 'https://hybridai.one').replace(/\/+$/g, '')}${GIT_CREDENTIAL_PATH}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const body: unknown = response.ok ? await response.json() : null;
    if (isRecord(body) && typeof body.password === 'string' && body.password)
      token = body.password;
    else if (response.status !== 404)
      logger.warn(
        { status: response.status },
        'GitHub shell credential unavailable',
      );
  } catch (error) {
    logger.warn({ error }, 'GitHub shell credential request failed');
  }
  cached = {
    apiKey,
    token,
    expiresAt: Date.now() + (token ? TOKEN_TTL_MS : MISS_TTL_MS),
  };
  return token;
}

export async function resolveGitHubShellToken(
  scope: RuntimeScope | undefined,
): Promise<string | null> {
  if (
    scope &&
    !getScope(scope.agentId, scope.scopeId)?.connectors.includes('github')
  )
    return null;
  const apiKey = readHybridAIApiKey();
  if (!apiKey) return null;
  if (cached?.apiKey === apiKey && cached.expiresAt > Date.now())
    return cached.token;
  inFlight ??= fetchToken(apiKey).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
