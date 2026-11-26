/**
 * Teams SDK authentication is built exclusively from the configured channel credentials.
 * Unlike the webhook bridge, this module selects inbound issuer validation and
 * outbound client credentials. Verified service URL claims bind the complete reply
 * endpoint before processing; environment defaults cannot disable either check.
 */
import type { Activity } from '@microsoft/agents-activity';
import {
  CloudAdapter,
  ConnectorClient,
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

/**
 * A relay that owns the bot registration verifies the Bot Framework request,
 * forwards the activity, and carries every connector call back to Teams. The
 * gateway then holds no bot secret: an activity's service URL is the relay,
 * and the relay credential goes there and nowhere else.
 */
class RelayedMSTeamsAdapter extends CloudAdapter {
  constructor(private readonly relay: () => MSTeamsRelay | null) {
    super({ clientId: 'msteams-relay' }, undefined, undefined, {
      validateServiceUrl: true,
    });
  }

  protected override async createConnectorClientWithIdentity(
    _identity: unknown,
    activity: Activity,
    headers?: Parameters<typeof ConnectorClient.createClientWithToken>[2],
  ): Promise<ConnectorClient> {
    const relay = this.relay();
    const serviceUrl = String(activity.serviceUrl || '');
    if (!relay || !isMSTeamsRelayServiceUrl(relay, serviceUrl)) {
      throw new Error('Teams service URL is not the configured relay.');
    }
    return ConnectorClient.createClientWithToken(
      serviceUrl,
      relay.token,
      headers,
    );
  }
}

export interface MSTeamsRelay {
  baseUrl: string;
  token: string;
}

/** The relay's Bot Connector surface on the platform. */
const MSTEAMS_RELAY_PATH = '/api/hybridclaw/msteams/';

/**
 * True for an address on the relay's own surface of the platform: same
 * origin, below the relay path, and written exactly as it parses, so nothing
 * like `..`, a query or a fragment can point the relay credential at another
 * platform route.
 */
export function isMSTeamsRelayServiceUrl(
  relay: MSTeamsRelay,
  serviceUrl: unknown,
): boolean {
  if (typeof serviceUrl !== 'string') return false;
  let url: URL;
  let base: URL;
  try {
    url = new URL(serviceUrl);
    base = new URL(relay.baseUrl);
  } catch {
    return false;
  }
  const relayPath = `${base.pathname.replace(/\/+$/, '')}${MSTEAMS_RELAY_PATH}`;
  return (
    url.origin === base.origin &&
    url.href === serviceUrl &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname.startsWith(relayPath)
  );
}

/** A Teams id that is safe as one segment of a relay path. */
export function isMSTeamsPathId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9:@._;=-]{1,255}$/.test(value) &&
    !/^\.+$/.test(value)
  );
}

export function createMSTeamsRelayAdapter(
  relay: () => MSTeamsRelay | null,
): CloudAdapter {
  return new RelayedMSTeamsAdapter(relay);
}
