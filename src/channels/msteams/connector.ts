/**
 * Teams connector access uses the authenticated adapter's per-turn client.
 * Unlike attachment policy, this module only locates the existing client;
 * it never constructs credentials or grants a new destination.
 */
import type { ConnectorClient, TurnContext } from '@microsoft/agents-hosting';

export function requireMSTeamsConnectorClient(
  turnContext: TurnContext,
): ConnectorClient {
  const connectorKey = turnContext.adapter.ConnectorClientKey;
  const client = turnContext.turnState.get<ConnectorClient>(connectorKey);
  if (!client) throw new Error('Teams connector client is unavailable.');
  return client;
}
