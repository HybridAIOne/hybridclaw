/**
 * Shell credentials are resolved only when an approved shell tool executes.
 * Unlike chat setup, this gateway-token-only handoff may refresh OAuth; it
 * returns short-lived CLI credentials, never the stored refresh credentials.
 */
import type { ServerResponse } from 'node:http';
import {
  getGoogleWorkspaceRuntimeEnvRecoveryHint,
  resolveGoogleWorkspaceRuntimeEnv,
} from '../auth/google-auth.js';
import { logger } from '../logger.js';
import type { RuntimeScope } from '../scopes/scope-runtime-auth.js';
import { sendJson } from './gateway-http-utils.js';
import { resolveGitHubShellToken } from './github-shell-token.js';

export async function handleApiShellEnv(
  res: ServerResponse,
  authenticated: boolean,
  scope?: RuntimeScope,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!authenticated) {
    sendJson(res, 401, { error: 'Gateway API authentication required.' });
    return;
  }
  const [env, githubToken] = await Promise.all([
    resolveGoogleWorkspaceRuntimeEnv().catch((error) => {
      // Optional CLI credentials must not prevent unrelated shell commands.
      logger.warn(getGoogleWorkspaceRuntimeEnvRecoveryHint(error));
      return {};
    }),
    resolveGitHubShellToken(scope),
  ]);
  sendJson(res, 200, githubToken ? { ...env, GH_TOKEN: githubToken } : env);
}
