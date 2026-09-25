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
import { sendJson } from './gateway-http-utils.js';

export async function handleApiShellEnv(
  res: ServerResponse,
  authenticated: boolean,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!authenticated) {
    sendJson(res, 401, { error: 'Gateway API authentication required.' });
    return;
  }
  const env = await resolveGoogleWorkspaceRuntimeEnv().catch((error) => {
    // Optional CLI credentials must not prevent unrelated shell commands.
    logger.warn(getGoogleWorkspaceRuntimeEnvRecoveryHint(error));
    return {};
  });
  sendJson(res, 200, env);
}
