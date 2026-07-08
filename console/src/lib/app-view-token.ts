import { createAdminApiToken } from '../api/client';

const APP_VIEW_TOKEN_TTL_MS = 30 * 60 * 1000;

export async function createAppViewToken(
  authToken: string,
  appId: string,
): Promise<string> {
  const expiresAt = new Date(Date.now() + APP_VIEW_TOKEN_TTL_MS).toISOString();
  const result = await createAdminApiToken(authToken, {
    label: `App view ${appId.slice(0, 48)}`,
    claims: {
      actions: ['apps.view', 'apps.bridge'],
      appIds: [appId],
    },
    expiresAt,
  });
  return result.token;
}
