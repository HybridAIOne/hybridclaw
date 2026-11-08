/**
 * Teams SDK authentication is built exclusively from the configured channel credentials.
 * Unlike the webhook bridge, this module selects inbound issuer validation and
 * outbound client credentials; environment SDK defaults cannot disable authentication.
 * An activity's serviceUrl must match its token's serviceurl claim, so a replayed
 * token cannot redirect the bot's outbound credentials to another host.
 */
import { CloudAdapter } from '@microsoft/agents-hosting';

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
