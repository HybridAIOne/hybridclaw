import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { Activity } from '@microsoft/agents-activity';
import {
  AuthType,
  clearJwksClients,
  MsalTokenProvider,
  type Request as TeamsRequest,
  type WebResponse,
} from '@microsoft/agents-hosting';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createMSTeamsAdapter } from '../src/channels/msteams/adapter.js';
import { useCleanMocks } from './test-utils.js';

const appId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const otherTenant = '33333333-3333-4333-8333-333333333333';
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const credentials = { appId, password: 'example-secret', tenantId };
const keys = await generateKeyPair('RS256');
const wrongKeys = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'example-key',
  use: 'sig',
};
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [jwk] }));
});
let port = 0;
useCleanMocks({
  restoreAllMocks: true,
  unstubAllGlobals: true,
  unstubAllEnvs: true,
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  clearJwksClients();
  MsalTokenProvider.clearSharedCaches();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  clearJwksClients();
  MsalTokenProvider.clearSharedCaches();
  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback?: (res: http.IncomingMessage) => void,
  ) => {
    expect(['login.microsoftonline.com', 'login.botframework.com']).toContain(
      options.hostname,
    );
    expect(String(options.path)).toMatch(
      /(?:discovery\/v2\.0\/keys|\.well-known\/keys)$/,
    );
    return http.request({ ...options, hostname: '127.0.0.1', port }, callback);
  }) as typeof https.request);
});

async function token(
  payload: Record<string, unknown> = {},
  wrongKey = false,
): Promise<string> {
  return new SignJWT({ aud: appId, iss: issuer, tid: tenantId, ...payload })
    .setProtectedHeader({ alg: 'RS256', kid: 'example-key' })
    .setIssuedAt()
    .setExpirationTime(typeof payload.exp === 'number' ? payload.exp : '5m')
    .sign(wrongKey ? wrongKeys.privateKey : keys.privateKey);
}
function response() {
  const result = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    writableEnded: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(_name: string, _value: string) {
      return this;
    },
    send(body?: unknown) {
      this.body = body;
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
    end() {
      this.writableEnded = true;
      return this;
    },
  } satisfies WebResponse;
  return result;
}
async function authorize(authorization?: string, tenant = tenantId) {
  const adapter = createMSTeamsAdapter({ ...credentials, tenantId: tenant });
  const req: TeamsRequest = { method: 'POST', headers: { authorization } };
  const res = response();
  const next = vi.fn();
  await adapter.authorizeRequest(req, res, next);
  return { req, res, next };
}

describe('real Teams SDK JWT boundary with local signing keys', () => {
  it.each([issuer, 'https://api.botframework.com'])(
    'accepts an authentic token from %s',
    async (iss) => {
      const { req, res, next } = await authorize(
        `Bearer ${await token({ iss })}`,
      );
      expect(next).toHaveBeenCalledOnce();
      expect(req.user?.aud).toBe(appId);
      expect(res.writableEnded).toBe(false);
    },
  );

  it.each([
    ['wrong audience', { aud: '44444444-4444-4444-8444-444444444444' }],
    ['untrusted issuer', { iss: 'https://example.com/issuer' }],
    [
      'different tenant',
      {
        iss: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
        tid: otherTenant,
      },
    ],
    ['issuer and tenant disagree', { tid: otherTenant }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 600 }],
    ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 600 }],
  ])('rejects %s before invoking the continuation', async (_label, payload) => {
    const { req, res, next } = await authorize(
      `Bearer ${await token(payload)}`,
    );
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(res.writableEnded).toBe(true);
  });

  it('rejects a token signed with another key', async () => {
    const { res, next } = await authorize(`Bearer ${await token({}, true)}`);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it.each([undefined, '', 'Basic example', 'Bearer', 'Bearer invalid'])(
    'rejects malformed or missing credentials: %s',
    async (header) => {
      const { res, next } = await authorize(header);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    },
  );

  it('keeps the credentialed legacy multi-tenant Bot Service path authenticated', async () => {
    const good = await authorize(
      `Bearer ${await token({ iss: 'https://api.botframework.com' })}`,
      '',
    );
    expect(good.next).toHaveBeenCalledOnce();
    expect((await authorize(undefined, '')).res.statusCode).toBe(401);
  });

  it.each([
    ['https://smba.trafficmanager.net/amer/', 200, 1],
    ['https://attacker.example.com/', 400, 0],
  ])(
    'binds activity serviceUrl %s to the token claim',
    async (serviceUrl, status, logicCalls) => {
      vi.spyOn(MsalTokenProvider.prototype, 'getAccessToken').mockResolvedValue(
        'example-access-token',
      );
      const adapter = createMSTeamsAdapter(credentials);
      const req: TeamsRequest = {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token({
            iss: 'https://api.botframework.com',
            serviceurl: 'https://smba.trafficmanager.net/amer/',
          })}`,
        },
        body: {
          type: 'message',
          id: 'activity-id',
          channelId: 'msteams',
          serviceUrl,
          conversation: { id: 'conversation-id' },
          from: { id: 'user-id' },
          recipient: { id: 'bot-id' },
        },
      };
      const res = response();
      const next = vi.fn();
      await adapter.authorizeRequest(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      const logic = vi.fn(async () => {});
      await adapter.process(req, res, logic);
      expect(res.statusCode).toBe(status);
      expect(logic).toHaveBeenCalledTimes(logicCalls);
    },
  );
});

it.each([tenantId, 'botframework.com'])(
  'acquires an outbound token with real MSAL 7 for %s',
  async (tenant) => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        expect(url.hostname).toBe('login.microsoftonline.com');
        calls.push({ url, init });
        const origin = `https://login.microsoftonline.com/${tenant}`;
        if (url.pathname.endsWith('/.well-known/openid-configuration')) {
          return Response.json({
            authorization_endpoint: `${origin}/oauth2/v2.0/authorize`,
            token_endpoint: `${origin}/oauth2/v2.0/token`,
            issuer: `${origin}/v2.0`,
            jwks_uri: `${origin}/discovery/v2.0/keys`,
            end_session_endpoint: `${origin}/oauth2/v2.0/logout`,
          });
        }
        expect(url.pathname).toBe(`/${tenant}/oauth2/v2.0/token`);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('client_id')).toBe(appId);
        expect(form.get('client_secret')).toBe(credentials.password);
        expect(form.get('grant_type')).toBe('client_credentials');
        expect(form.get('scope')).toBe('https://api.botframework.com/.default');
        return Response.json({
          access_token: 'example-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }),
    );
    const provider = new MsalTokenProvider({
      clientId: appId,
      clientSecret: credentials.password,
      tenantId: tenant,
      authType: AuthType.ClientSecret,
    });
    await expect(
      provider.getAccessToken('https://api.botframework.com'),
    ).resolves.toBe('example-access-token');
    expect(calls.some(({ url }) => url.pathname.endsWith('/token'))).toBe(true);
  },
);

it('preserves Teams wire payloads through patched Zod and Activity parsing', () => {
  const activity = Activity.fromObject({
    type: 'message',
    channelId: 'msteams',
    text: '<at>Helper</at> hello',
    recipient: { id: 'bot-id' },
    from: { id: 'user-id', aadObjectId: tenantId },
    conversation: {
      id: 'conversation-id',
      conversationType: 'personal',
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
    entities: [
      { type: 'mention', mentioned: { id: 'bot-id' }, text: '<at>Helper</at>' },
      { type: 'streaminfo', streamType: 'final', streamSequence: 3 },
    ],
    semanticAction: {
      id: 'example-action',
      state: 'start',
      entities: { subject: { type: 'Thing', name: 'example' } },
    },
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          body: [{ type: 'TextBlock', text: 'example' }],
        },
      },
    ],
  });
  expect(activity.removeRecipientMention()).toBe('hello');
  expect(activity.from?.aadObjectId).toBe(tenantId);
  expect(activity.channelData).toEqual({ tenant: { id: tenantId } });
  expect(activity.entities?.[1]).toMatchObject({
    streamType: 'final',
    streamSequence: 3,
  });
  expect(activity.attachments?.[0].content).toMatchObject({
    body: [{ text: 'example' }],
  });
  expect(activity.semanticAction?.entities).toMatchObject({
    subject: { name: 'example' },
  });
  expect(() =>
    Activity.fromObject({ type: 'message', attachments: 'invalid' }),
  ).toThrow();
});

it('keeps unrelated SDK environment connections outside Teams authentication', () => {
  const adapterUrl = new URL(
    '../src/channels/msteams/adapter.ts',
    import.meta.url,
  ).href;
  const script = `
    import https from 'node:https';
    import { createMSTeamsAdapter } from ${JSON.stringify(adapterUrl)};
    let networkCalls = 0;
    https.request = () => { networkCalls++; throw new Error('Unexpected network'); };
    const adapter = createMSTeamsAdapter(${JSON.stringify(credentials)});
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const raw = encode({alg:'RS256',kid:'example-key'}) + '.' + encode({aud:'unrelated-app-id',iss:'https://api.botframework.com',exp:Math.floor(Date.now()/1000)+300}) + '.ZXhhbXBsZQ';
    let status = 200, authorized = false;
    const res = { status(code) { status=code; return this; }, send() { return this; } };
    await adapter.authorizeRequest({method:'POST',headers:{authorization:'Bearer '+raw}},res,()=>{authorized=true;});
    console.log(JSON.stringify({clientId:adapter.getClientId(),networkCalls,status,authorized}));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        connections__Other__settings__clientId: 'unrelated-app-id',
        connections__Other__settings__clientSecret: 'unrelated-secret',
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    clientId: appId,
    networkCalls: 0,
    status: 401,
    authorized: false,
  });
});
