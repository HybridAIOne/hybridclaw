import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(process.cwd(), 'skills', 'zabbix', 'zabbix.cjs');
const skillPath = path.join(process.cwd(), 'skills', 'zabbix', 'SKILL.md');
const require = createRequire(import.meta.url);

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Zabbix skill manifest declares SecretRef credential metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, { name: 'zabbix' });

  expect(manifest.credentials).toEqual([
    {
      id: 'zabbix-api-token',
      kind: 'bearer',
      required: true,
      secretRef: {
        source: 'store',
        id: 'ZABBIX_API_TOKEN',
      },
      scope: 'https://<zabbix-frontend>/api_jsonrpc.php Authorization bearer',
      howToObtain:
        'Create a Zabbix API token in the Zabbix frontend and store it with\n' +
        '`hybridclaw secret set ZABBIX_API_TOKEN "<token>"`.',
    },
  ]);
  expect(skill).toContain('category: production-ops');
  expect(skill).toContain('event-acknowledge');
  expect(skill).toContain('event-close');
  expect(skill).toContain('Stop after that first failed live');
});

test('Zabbix helper --help exits cleanly without secret flags', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Zabbix skill helper');
  expect(result.stdout).toContain('api-version');
  expect(result.stdout).toContain('hosts');
  expect(result.stdout).toContain('problems');
  expect(result.stdout).toContain('triggers-problem');
  expect(result.stdout).not.toContain('--token');
  expect(result.stdout).not.toContain('--password');
});

test('Zabbix run mode prepares the same gateway-proxied request', () => {
  const zabbix = require('../skills/zabbix/zabbix.cjs');

  const payload = zabbix.buildRequest([
    'run',
    'problems',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--recent',
  ]);

  expect(payload).toMatchObject({
    command: 'run',
    httpRequest: {
      url: 'https://zabbix.example.com/zabbix/api_jsonrpc.php',
      bearerSecretName: 'ZABBIX_API_TOKEN',
      json: {
        method: 'problem.get',
      },
    },
  });
});

test('Zabbix helper normalizes frontend URLs to the JSON-RPC endpoint', () => {
  const frontend = runHelper([
    '--format',
    'json',
    'http-request',
    'api-version',
    '--base-url',
    'https://zabbix.example.com/zabbix',
  ]);
  const endpoint = runHelper([
    '--format',
    'json',
    'http-request',
    'api-version',
    '--base-url',
    'https://zabbix.example.com/zabbix/api_jsonrpc.php',
  ]);

  expect(frontend.status).toBe(0);
  expect(endpoint.status).toBe(0);
  expect(JSON.parse(frontend.stdout).httpRequest.url).toBe(
    'https://zabbix.example.com/zabbix/api_jsonrpc.php',
  );
  expect(JSON.parse(endpoint.stdout).httpRequest.url).toBe(
    'https://zabbix.example.com/zabbix/api_jsonrpc.php',
  );
});

test('Zabbix api-version request is unauthenticated and bounded', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'api-version',
    '--base-url',
    'https://zabbix.example.com/zabbix',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://zabbix.example.com/zabbix/api_jsonrpc.php',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json-rpc',
    },
    json: {
      jsonrpc: '2.0',
      method: 'apiinfo.version',
      params: {},
      id: 1,
    },
    skillName: 'zabbix',
    timeoutMs: 30000,
    maxResponseBytes: 200000,
  });
  expect(payload.httpRequest).not.toHaveProperty('bearerSecretName');
  expect(payload.httpRequest.headers).not.toHaveProperty('Authorization');
});

test('Zabbix host request injects bearer SecretRef field and explicit outputs', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'hosts',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--monitored-only',
    '--host',
    '10084',
    '--host-group',
    '2',
    '--tag',
    'role=db',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    bearerSecretName: 'ZABBIX_API_TOKEN',
    skillName: 'zabbix',
  });
  expect(payload.httpRequest.headers).not.toHaveProperty('Authorization');
  expect(payload.httpRequest.json).toMatchObject({
    method: 'host.get',
    params: {
      output: ['hostid', 'host', 'name', 'status', 'maintenance_status'],
      selectInterfaces: ['interfaceid', 'ip', 'dns', 'type', 'main', 'useip'],
      selectTags: ['tag', 'value'],
      monitored_hosts: true,
      hostids: ['10084'],
      groupids: ['2'],
      tags: [{ tag: 'role', value: 'db' }],
      sortfield: 'name',
    },
    id: 2,
  });
  expect(result.stdout).not.toContain('Authorization');
});

test('Zabbix problem request supports recent, bounds, and incident filters', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'problems',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--recent',
    '--limit',
    '25',
    '--host-id',
    '10084,10085',
    '--group-id',
    '2',
    '--severity',
    'high,disaster',
    '--unacknowledged',
    '--unsuppressed',
    '--tag',
    'service=postgres',
    '--time-from',
    '1767225600',
    '--time-till',
    '1767312000',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    bearerSecretName: 'ZABBIX_API_TOKEN',
    maxResponseBytes: 4000000,
  });
  expect(payload.httpRequest.json).toMatchObject({
    method: 'problem.get',
    params: {
      output: 'extend',
      selectAcknowledges: 'extend',
      selectTags: 'extend',
      selectSuppressionData: 'extend',
      recent: true,
      sortfield: ['eventid'],
      sortorder: 'DESC',
      limit: 25,
      hostids: ['10084', '10085'],
      groupids: ['2'],
      severities: [4, 5],
      acknowledged: false,
      suppressed: false,
      tags: [{ tag: 'service', value: 'postgres' }],
      time_from: 1767225600,
      time_till: 1767312000,
    },
    id: 3,
  });
});

test('Zabbix trigger problem request follows documented problem-state pattern', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'triggers-problem',
    '--base-url',
    'https://zabbix.example.com/zabbix/api_jsonrpc.php',
    '--limit',
    '10',
    '--severity',
    'warning',
    '--tag',
    'team=infra',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest.json).toMatchObject({
    method: 'trigger.get',
    params: {
      output: ['triggerid', 'description', 'priority', 'lastchange'],
      selectHosts: ['hostid', 'host', 'name'],
      selectTags: 'extend',
      filter: {
        value: 1,
      },
      sortfield: 'priority',
      sortorder: 'DESC',
      limit: 10,
      severities: [2],
      tags: [{ tag: 'team', value: 'infra' }],
    },
    id: 4,
  });
});

test('Zabbix helper validates limit bounds and mutually exclusive filters', () => {
  const tooLarge = runHelper([
    '--format',
    'json',
    'http-request',
    'problems',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--limit',
    '101',
  ]);
  const notInteger = runHelper([
    '--format',
    'json',
    'http-request',
    'triggers-problem',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--limit',
    '25.5',
  ]);
  const conflictingAck = runHelper([
    '--format',
    'json',
    'http-request',
    'problems',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--acknowledged',
    '--unacknowledged',
  ]);

  expect(tooLarge.status).not.toBe(0);
  expect(tooLarge.stderr).toContain('--limit must be between 1 and 100.');
  expect(notInteger.status).not.toBe(0);
  expect(notInteger.stderr).toContain(
    '--limit must be an integer between 1 and 100.',
  );
  expect(conflictingAck.status).not.toBe(0);
  expect(conflictingAck.stderr).toContain(
    'Use only one of --acknowledged or --unacknowledged.',
  );
});

test('Zabbix helper rejects cleartext credential flags without echoing values', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'hosts',
    '--base-url',
    'https://zabbix.example.com/zabbix',
    '--token',
    'super-secret-token',
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    '--token is not supported. Store Zabbix credentials in ZABBIX_API_TOKEN.',
  );
  expect(result.stderr).not.toContain('super-secret-token');
  expect(result.stdout).not.toContain('super-secret-token');
});

test('Zabbix live executor uses the gateway http_request route without exposing secrets', async () => {
  const zabbix = require('../skills/zabbix/zabbix.cjs');
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({
          jsonrpc: '2.0',
          result: '7.4.0',
          id: 1,
        }),
      }),
  });
  const payload = zabbix.buildRequest([
    'http-request',
    'api-version',
    '--base-url',
    'https://zabbix.example.com/zabbix',
  ]);

  const result = await zabbix.executeZabbixGatewayRequest(payload.httpRequest, {
    gatewayUrl: 'http://127.0.0.1:9090',
    gatewayToken: 'gateway-token',
    fetch: fetchMock,
  });

  expect(result.bodyJson.result).toBe('7.4.0');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9090/api/http/request',
    expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gateway-token',
      },
    }),
  );
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).not.toHaveProperty('Authorization');
  expect(JSON.stringify(body)).not.toContain('gateway-token');
  expect(JSON.stringify(body)).not.toContain('zabbix-api-token');
});

test('Zabbix live executor stops after one Zabbix 401 response', async () => {
  const zabbix = require('../skills/zabbix/zabbix.cjs');
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        body: '{"error":"invalid bearer token"}',
      }),
  });
  const payload = zabbix.buildRequest([
    'http-request',
    'problems',
    '--base-url',
    'https://zabbix.example.com/zabbix',
  ]);

  await expect(
    zabbix.executeZabbixGatewayRequest(payload.httpRequest, {
      gatewayUrl: 'http://127.0.0.1:9090',
      gatewayToken: 'gateway-token',
      fetch: fetchMock,
    }),
  ).rejects.toThrow(
    'Zabbix returned HTTP 401 for the first live call. Check ZABBIX_API_TOKEN',
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
