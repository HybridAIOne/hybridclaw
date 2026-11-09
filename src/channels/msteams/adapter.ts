/**
 * Teams SDK authentication is built exclusively from the configured channel credentials.
 * Unlike the webhook bridge, this module selects inbound issuer validation and
 * outbound client credentials. Verified service URL claims bind the complete reply
 * endpoint before processing; environment defaults cannot disable either check.
 */
import {
  CloudAdapter,
  type Request,
  type WebResponse,
} from '@microsoft/agents-hosting';

export function createMSTeamsAdapter(credentials: {
  appId: string;
  password: string;
  tenantId: string;
}): CloudAdapter {
  const connectionName = 'msteams';
  const connection = {
    clientId: credentials.appId,
    clientSecret: credentials.password,
    tenantId: credentials.tenantId || 'botframework.com',
    validateIssuer: true,
  };
  return new CloudAdapter(
    {
      ...connection,
      connectionName,
      connections: new Map([[connectionName, connection]]),
      connectionsMap: [{ serviceUrl: '*', connection: connectionName }],
    },
    undefined,
    undefined,
    { validateServiceUrl: true },
  );
}

export async function authorizeMSTeamsWebhook(
  adapter: CloudAdapter,
  request: Request<Record<string, unknown>>,
  response: WebResponse,
): Promise<boolean> {
  let authorized = false;
  await adapter.authorizeRequest(request, response, () => {
    authorized = true;
  });
  if (!authorized) return false;
  const claim = request.user?.serviceurl;
  // The SDK compares hostnames; retain Bot Framework's full-URL claim binding.
  if (
    (request.user?.iss === 'https://api.botframework.com' ||
      claim !== undefined) &&
    (typeof claim !== 'string' || !claim || claim !== request.body?.serviceUrl)
  ) {
    response.status(401).end();
    return false;
  }
  return true;
}
