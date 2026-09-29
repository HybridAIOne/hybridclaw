import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, type Mock, test, vi } from 'vitest';
import YAML from 'yaml';

import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-http-secret-selectors-');
useCleanMocks({
  restoreAllMocks: true,
  resetModules: true,
  unstubAllGlobals: true,
});

const require = createRequire(import.meta.url);
const homematic = require('../skills/homematic/homematic.cjs');

const API_URL = 'https://api.example.com/v1/items';
const OTC_URL = 'https://iam.eu-de.otc.t-systems.com/v3/auth/tokens';
const STORED_SECRETS: Record<string, string> = {
  API_KEY: 'api-key-value',
  API_KEY_BOUND_DOMAIN: 'api.example.com',
  OTC_ACCESS_KEY_ID: 'otc-access-key-id',
  OTC_SECRET_ACCESS_KEY: 'otc-secret-access-key',
  HOMEMATIC_HCU_ACTIVATION_KEY: 'hcu-activation-key',
  HOMEMATIC_HCU_AUTH_TOKEN: 'hcu-auth-token',
};

async function loadProxy(secretPolicy?: Record<string, unknown>) {
  const workspacePath = makeTempDir();
  if (secretPolicy) {
    fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
      YAML.stringify({ secret: secretPolicy }),
    );
  }
  const recordAuditEvent = vi.fn();
  vi.doMock('node:dns/promises', () => ({
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  }));
  vi.doMock('../src/infra/ipc.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/infra/ipc.js')>()),
    agentWorkspaceDir: () => workspacePath,
  }));
  vi.doMock('../src/audit/audit-events.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/audit/audit-events.js')>()),
    makeAuditRunId: () => 'run-secret',
    recordAuditEvent,
  }));
  vi.doMock('../src/security/runtime-secrets.js', async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../src/security/runtime-secrets.js')
    >()),
    readStoredRuntimeSecret: (name: string) => STORED_SECRETS[name] ?? null,
  }));
  const fetchMock = vi.fn(
    async (_url: URL, _init: RequestInit) =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const { handleApiHttpRequest } = await import(
    '../src/gateway/gateway-http-proxy.js'
  );

  // Answers with the status the gateway server sends: the handler's own, or
  // the status of the GatewayRequestError it throws.
  const send = async (body: Record<string, unknown>): Promise<number> => {
    let statusCode = 0;
    const res = {
      writeHead: (status: number) => {
        statusCode = status;
      },
      end: () => {},
    };
    try {
      await handleApiHttpRequest(res as unknown as ServerResponse, body);
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      if (typeof status !== 'number') throw error;
      return status;
    }
    return statusCode;
  };
  return { send, fetchMock, recordAuditEvent };
}

function resolvedSelectors(recordAuditEvent: Mock): string[] {
  return recordAuditEvent.mock.calls
    .map(([entry]) => entry.event)
    .filter((event) => event.type === 'secret.resolved')
    .map((event) => event.selector);
}

describe('http_request secret selectors', () => {
  test.each([
    {
      position: 'the URL',
      request: { url: `${API_URL}?key=<secret:API_KEY>` },
      selectors: ['url'],
    },
    {
      position: 'a header',
      request: { url: API_URL, headers: { 'X-Api-Key': '<secret:API_KEY>' } },
      selectors: ['X-Api-Key'],
    },
    {
      position: 'secretHeaders',
      request: {
        url: API_URL,
        secretHeaders: [
          { name: 'X-Api-Key', secretName: 'API_KEY', prefix: 'none' },
        ],
      },
      selectors: ['X-Api-Key'],
    },
    {
      position: 'bearerSecretName',
      request: { url: API_URL, bearerSecretName: 'API_KEY' },
      selectors: ['Authorization'],
    },
    {
      position: 'a string body',
      request: { url: API_URL, method: 'POST', body: 'key=<secret:API_KEY>' },
      selectors: ['body'],
    },
    {
      position: 'a form field',
      request: {
        url: API_URL,
        method: 'POST',
        form: { apiKey: '<secret:API_KEY>' },
      },
      selectors: ['form.apiKey'],
    },
    {
      position: 'a top-level json key',
      request: {
        url: API_URL,
        method: 'POST',
        json: { apiKey: '<secret:API_KEY>' },
      },
      selectors: ['json'],
    },
    {
      position: 'a nested json key',
      request: {
        url: API_URL,
        method: 'POST',
        json: { auth: { apiKey: '<secret:API_KEY>' } },
      },
      selectors: ['json'],
    },
    {
      position: 'a json array item',
      request: {
        url: API_URL,
        method: 'POST',
        json: { keys: ['<secret:API_KEY>'] },
      },
      selectors: ['json'],
    },
    {
      position: 'a json string',
      request: { url: API_URL, method: 'POST', json: '<secret:API_KEY>' },
      selectors: ['json'],
    },
    {
      position: 'an otcAkSk-signed json body',
      request: {
        url: OTC_URL,
        method: 'POST',
        otcAkSk: {
          accessKeyIdSecretName: 'OTC_ACCESS_KEY_ID',
          secretAccessKeySecretName: 'OTC_SECRET_ACCESS_KEY',
        },
        json: { auth: { apiKey: '<secret:API_KEY>' } },
      },
      selectors: ['json', 'otcAkSk.accessKeyId', 'otcAkSk.secretAccessKey'],
    },
  ])('reports the selector for a secret in $position', async ({
    request,
    selectors,
  }) => {
    const { send, fetchMock, recordAuditEvent } = await loadProxy();

    expect(await send(request)).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resolvedSelectors(recordAuditEvent)).toEqual(selectors);
  });

  test('json placeholders resolve at every depth and keep the body shape', async () => {
    const { send, fetchMock, recordAuditEvent } = await loadProxy();

    expect(
      await send({
        url: API_URL,
        method: 'POST',
        json: {
          apiKey: '<secret:API_KEY>',
          auth: { header: 'Key <secret:API_KEY>' },
          list: ['<secret:API_KEY>', 2, null, true],
          count: 3,
        },
      }),
    ).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body))).toEqual({
      apiKey: 'api-key-value',
      auth: { header: 'Key api-key-value' },
      list: ['api-key-value', 2, null, true],
      count: 3,
    });
    expect(resolvedSelectors(recordAuditEvent)).toEqual([
      'json',
      'json',
      'json',
    ]);
  });

  const allowApiKeyFor = (selector: string) => ({
    default: 'deny',
    rules: [
      {
        action: 'allow',
        when: {
          predicate: 'secret_resolve_allowed',
          id: 'API_KEY',
          sink: 'http',
          host: 'api.example.com',
          selector,
        },
      },
    ],
  });

  test.each([
    { rule: 'allow selector json', policy: allowApiKeyFor('json'), status: 200 },
    {
      rule: 'allow selector json.auth.apiKey',
      policy: allowApiKeyFor('json.auth.apiKey'),
      status: 403,
    },
    {
      rule: 'allow selector json.*',
      policy: allowApiKeyFor('json.*'),
      status: 403,
    },
    {
      rule: 'deny selector json',
      policy: {
        rules: [
          {
            action: 'deny',
            when: { predicate: 'secret.selector', equals: 'json' },
          },
        ],
      },
      status: 403,
    },
  ])('a rule to $rule answers a nested json secret with $status', async ({
    policy,
    status,
  }) => {
    const { send, fetchMock } = await loadProxy(policy);

    expect(
      await send({
        url: API_URL,
        method: 'POST',
        json: { auth: { apiKey: '<secret:API_KEY>' } },
      }),
    ).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  test('Homematic secret rules admit its json auth requests under a deny default', async () => {
    const hcuUrl = ['--hcu-url', 'https://hcu.example.com'];
    const { secret } = homematic.buildRequest([
      'policy-rules',
      ...hcuUrl,
      '--agent',
      'main',
    ]);
    const { send, fetchMock, recordAuditEvent } = await loadProxy({
      default: 'deny',
      rules: secret.rules,
    });

    for (const operation of ['auth-token', 'confirm-token']) {
      const { httpRequest } = homematic.buildRequest([
        'http-request',
        operation,
        ...hcuUrl,
      ]);
      expect(await send({ ...httpRequest, agentId: 'main' })).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolvedSelectors(recordAuditEvent)).toEqual([
      'json',
      'json',
      'json',
    ]);
  });
});
