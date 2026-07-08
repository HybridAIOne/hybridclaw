import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { describe, expect, test } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import {
  MSTeamsTabTokenError,
  resolveMSTeamsTabConfig,
  TEAMS_TAB_SCOPE,
  validateMSTeamsTabIdToken,
} from '../src/gateway/msteams-tab.js';
import { getRuntimeConfig } from '../src/config/runtime-config.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SSO_APP_ID = '22222222-2222-4222-8222-222222222222';
const APP_ID_URI = `api://example.test/${SSO_APP_ID}`;
const NOW = new Date('2026-07-08T12:00:00.000Z');

async function createJwtFixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = 'teams-test-key';
  return {
    privateKey,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  };
}

async function signTeamsToken(
  privateKey: KeyLike,
  options: {
    tenantId?: string;
    tid?: string;
    aud?: string;
    scp?: string;
    oid?: string;
    preferredUsername?: string;
    name?: string;
  } = {},
): Promise<string> {
  const tenantId = options.tenantId ?? TENANT_ID;
  return new SignJWT({
    tid: options.tid ?? tenantId,
    scp: options.scp ?? TEAMS_TAB_SCOPE,
    oid: options.oid ?? 'viewer-oid',
    preferred_username: options.preferredUsername ?? 'viewer@example.test',
    name: options.name ?? 'Viewer User',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'teams-test-key' })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(options.aud ?? APP_ID_URI)
    .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 60)
    .setNotBefore(Math.floor(NOW.getTime() / 1000) - 60)
    .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 60)
    .sign(privateKey);
}

describe('msteams tab SSO validation', () => {
  test('validates a Teams tab ID token and maps viewer claims', async () => {
    const fixture = await createJwtFixture();
    const token = await signTeamsToken(fixture.privateKey);

    await expect(
      validateMSTeamsTabIdToken(token, {
        tenantId: TENANT_ID,
        ssoAppId: SSO_APP_ID,
        appIdUri: APP_ID_URI,
        now: NOW,
        jwks: fixture.jwks,
      }),
    ).resolves.toEqual({
      sub: 'viewer-oid',
      email: 'viewer@example.test',
      name: 'Viewer User',
    });
  });

  test('rejects wrong audiences', async () => {
    const fixture = await createJwtFixture();
    const token = await signTeamsToken(fixture.privateKey, {
      aud: 'api://wrong-audience',
    });

    await expect(
      validateMSTeamsTabIdToken(token, {
        tenantId: TENANT_ID,
        ssoAppId: SSO_APP_ID,
        appIdUri: APP_ID_URI,
        now: NOW,
        jwks: fixture.jwks,
      }),
    ).rejects.toMatchObject({
      name: 'MSTeamsTabTokenError',
      code: 'invalid_token',
    });
  });

  test('rejects tenant claim mismatches', async () => {
    const fixture = await createJwtFixture();
    const token = await signTeamsToken(fixture.privateKey, {
      tid: '33333333-3333-4333-8333-333333333333',
    });

    await expect(
      validateMSTeamsTabIdToken(token, {
        tenantId: TENANT_ID,
        ssoAppId: SSO_APP_ID,
        appIdUri: APP_ID_URI,
        now: NOW,
        jwks: fixture.jwks,
      }),
    ).rejects.toMatchObject({
      name: 'MSTeamsTabTokenError',
      code: 'wrong_tenant',
    });
  });

  test('requires the Teams access_as_user scope', async () => {
    const fixture = await createJwtFixture();
    const token = await signTeamsToken(fixture.privateKey, {
      scp: 'openid profile',
    });

    await expect(
      validateMSTeamsTabIdToken(token, {
        tenantId: TENANT_ID,
        ssoAppId: SSO_APP_ID,
        appIdUri: APP_ID_URI,
        now: NOW,
        jwks: fixture.jwks,
      }),
    ).rejects.toMatchObject({
      name: 'MSTeamsTabTokenError',
      code: 'missing_scope',
    });
  });

  test('enforces UPN and oid allowlists', async () => {
    const fixture = await createJwtFixture();
    const token = await signTeamsToken(fixture.privateKey);

    await expect(
      validateMSTeamsTabIdToken(token, {
        tenantId: TENANT_ID,
        ssoAppId: SSO_APP_ID,
        appIdUri: APP_ID_URI,
        allowFrom: ['VIEWER@example.test'],
        now: NOW,
        jwks: fixture.jwks,
      }),
    ).resolves.toMatchObject({ sub: 'viewer-oid' });

    await expect(
      validateMSTeamsTabIdToken(token, {
        tenantId: TENANT_ID,
        ssoAppId: SSO_APP_ID,
        appIdUri: APP_ID_URI,
        allowFrom: ['someone-else@example.test'],
        now: NOW,
        jwks: fixture.jwks,
      }),
    ).rejects.toBeInstanceOf(MSTeamsTabTokenError);
  });

  test('resolves tab defaults from the Teams bot app and public origin', () => {
    const base = getRuntimeConfig();
    const config: RuntimeConfig = {
      ...base,
      msteams: {
        ...base.msteams,
        appId: SSO_APP_ID,
        tenantId: TENANT_ID,
        tab: {
          enabled: true,
          ssoAppId: '',
          appIdUri: '',
          allowFrom: ['viewer@example.test'],
        },
      },
    };

    expect(resolveMSTeamsTabConfig(config, 'https://example.test')).toEqual({
      enabled: true,
      tenantId: TENANT_ID,
      ssoAppId: SSO_APP_ID,
      appIdUri: APP_ID_URI,
      allowFrom: ['viewer@example.test'],
    });
  });
});
