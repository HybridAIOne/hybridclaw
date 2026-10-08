import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

// The distill plugin's console API, registered through the real plugin API
// and registry and served by the gateway's plugin admin-route dispatcher.
const makeTempDir = useTempDir('hybridclaw-distill-plugin-');
useCleanMocks({ unstubAllEnvs: true, restoreAllMocks: true });

let server: http.Server | null = null;
let base = '';
let home = '';

async function startDistillApi(): Promise<void> {
  vi.resetModules();
  vi.doMock('@hybridaione/hybridclaw/plugin-sdk', () =>
    import('../src/plugins/plugin-sdk.ts'),
  );
  const { initDatabase } = await import('../src/memory/db.js');
  initDatabase({ quiet: true });
  const { getRuntimeConfig } = await import('../src/config/runtime-config.js');
  const { getPluginManager, loadPluginManifest } = await import(
    '../src/plugins/plugin-manager.js'
  );
  const { createPluginApi } = await import('../src/plugins/plugin-api.js');
  const { handleGatewayPluginAdminRoute } = await import(
    '../src/gateway/gateway-plugin-admin-routes.js'
  );
  const { WebhookHttpError } = await import('../src/channels/webhook-http.js');
  const plugin = (await import('../plugins/distill/src/index.js')).default;
  const manager = getPluginManager();
  plugin.register(
    createPluginApi({
      manager,
      pluginId: 'distill',
      pluginDir: path.resolve('plugins/distill'),
      registrationMode: 'full',
      config: getRuntimeConfig(),
      pluginConfig: {},
      declaredEnv: [],
      declaredCliCommands: loadPluginManifest(
        path.resolve('plugins/distill/hybridclaw.plugin.yaml'),
      ).cliCommands,
      homeDir: home,
      cwd: home,
    }),
  );
  expect(manager.cliCommands.find('coworker')?.pluginId).toBe('distill');

  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    void handleGatewayPluginAdminRoute(req, res, url).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: Error) => {
        const status = error instanceof WebhookHttpError ? error.statusCode : 500;
        res.writeHead(status).end(error.message);
      },
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${base}/api/admin/distill${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

async function upload(alias: string, filename: string, content: string) {
  const response = await fetch(
    `${base}/api/admin/distill/sources/upload?alias=${alias}&kind=markdown`,
    {
      method: 'POST',
      headers: { 'x-hybridclaw-filename': encodeURIComponent(filename) },
      body: content,
    },
  );
  return { status: response.status, json: await response.json() };
}

beforeEach(async () => {
  home = makeTempDir();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', '');
  await startDistillApi();
}, 60_000);

afterEach(async () => {
  if (server) await new Promise((resolve) => server?.close(resolve));
  server = null;
  await cleanupGatewayRuntime();
});

test('creates a consented subject, uploads a source, runs, downloads and deletes a corpus document', async () => {
  const created = await call('POST', '/subjects', {
    alias: 'maya',
    displayName: 'Maya Lindqvist',
    matchAliases: ['maya@example.com'],
    realPerson: true,
  });
  expect(created.status).toBe(201);
  expect(created.json.subject.consent.valid).toBe(false);

  const blocked = await call('POST', '/runs', {
    alias: 'maya',
    sources: ['/does/not/matter'],
  });
  expect(blocked.status).toBe(409);
  expect(blocked.json.error).toContain('coworker consent record');

  const consented = await call('POST', '/consent', {
    alias: 'maya',
    grantedBy: 'Maya Lindqvist',
    method: 'written',
    statement: 'I consent to distillation.',
  });
  expect(consented.json.subject.consent.valid).toBe(true);

  const uploaded = await upload(
    'maya',
    '../memo.md',
    '# Decisions\n\nBoring options win until measurements demand otherwise.',
  );
  expect(uploaded.status).toBe(201);
  expect(uploaded.json.filename).toBe('memo.md');
  expect(uploaded.json.preview.content).toContain('Boring options win');
  expect(uploaded.json.path).toContain(
    path.join(home, '.hybridclaw', 'data', 'agents', 'maya', 'workspace'),
  );

  const run = await call('POST', '/runs', {
    alias: 'maya',
    sources: [uploaded.json.source],
    holdoutRatio: 0,
  });
  expect(run.status).toBe(200);
  expect(run.json.run.status).toBe('awaiting-extraction');
  expect(run.json.run.artifacts.report.content).toContain(run.json.run.runId);
  const documentId = run.json.subject.corpus[0].id;

  const download = await fetch(
    `${base}/api/admin/distill/corpus/${documentId}?alias=maya`,
  );
  expect(download.headers.get('content-disposition')).toContain(
    `${documentId}-Decisions.txt`,
  );
  expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await download.text()).toContain('Boring options win');

  const deleted = await call('DELETE', `/corpus/${documentId}?alias=maya`);
  expect(deleted.json.subject.corpusDocuments).toBe(0);
  expect((await call('GET', `/corpus/${documentId}?alias=maya`)).status).toBe(
    404,
  );

  const listed = await call('GET', '');
  expect(listed.json.subjects.map((s: { alias: string }) => s.alias)).toEqual([
    'maya',
  ]);
});

test('registering a subject creates the agent and backfills MEMORY.md', async () => {
  await call('POST', '/subjects', {
    alias: 'maya',
    displayName: 'Maya Lindqvist',
    role: 'Architect',
    realPerson: false,
  });
  const { resolveDistillPaths } = await import(
    '../plugins/distill/src/paths.js'
  );
  const { saveDistillState } = await import('../plugins/distill/src/state.js');
  const paths = resolveDistillPaths('maya', 'maya');
  const now = new Date().toISOString();
  saveDistillState(paths, {
    version: 1,
    subject: 'maya',
    analysedDocIds: ['doc_abc123abc123'],
    identity: { name: 'Maya', creature: 'Coworker', vibe: 'calm', emoji: '' },
    userNotes: [],
    skillName: 'maya-playbook',
    claims: [
      {
        id: 'claim_1',
        dimension: 'decision-making',
        claim: 'Prefers boring options until measurements demand otherwise.',
        evidence: ['doc_abc123abc123'],
        confidence: 0.9,
        status: 'standing',
        firstSeenRunId: 'dst_test',
        updatedAt: now,
      },
    ],
    mergeHistory: [
      {
        runId: 'dst_test',
        mergedAt: now,
        claimsAdded: 1,
        claimsSuperseded: 0,
        reviewsOpened: 0,
      },
    ],
  });

  const registered = await call('POST', '/register', { alias: 'maya' });
  expect(registered.status).toBe(201);
  expect(registered.json.subject.registeredAgent).toBe(true);
  const { getAgentById } = await import('../src/agents/agent-registry.js');
  expect(getAgentById('maya')).toMatchObject({
    id: 'maya',
    name: 'Maya Lindqvist',
    role: 'Architect',
  });
  const memory = fs.readFileSync(
    path.join(paths.workspaceDir, 'MEMORY.md'),
    'utf-8',
  );
  expect(memory).toContain('Distilled subject: Maya Lindqvist.');
  expect(memory).toContain('<!-- doc_abc123abc123 -->');
});

test.each([
  ['POST', '/subjects', {}, 400, '`alias` is required.'],
  ['POST', '/register', { alias: 'ghost' }, 404, 'No coworker subject'],
  [
    'POST',
    '/runs',
    { alias: 'nova', sources: ['/tmp/x.md'], holdoutRatio: 0.9 },
    400,
    'holdoutRatio',
  ],
  ['GET', '/corpus/not-a-doc?alias=maya', undefined, 404, 'No coworker'],
])('%s %s rejects bad input with %s', async (method, route, body, status, error) => {
  const response = await call(method, route, body);
  expect(response.status).toBe(status);
  expect(String(response.json.error)).toContain(error);
});
