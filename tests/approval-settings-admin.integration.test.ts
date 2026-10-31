import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { getAvailablePort } from './helpers/docker-test-setup.js';
import { useTempDir } from './test-utils.js';
const temp = useTempDir('approval-admin-');

test('admin mode changes are authenticated, conditional, persisted and audited without changing other sessions', async () => {
  const root = temp();
  const port = await getAvailablePort();
  const base = `http://127.0.0.1:${port}`;
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ops: { healthPort: port, dbPath: path.join(root, 'test.db') },
      hybridai: { baseUrl: 'http://127.0.0.1:9' },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { initDatabase, getOrCreateSession, updateSessionFullAuto } from './src/memory/db.ts';
    import { startGatewayHttpServer } from './src/gateway/gateway-http-server.ts';
    initDatabase({quiet:true});
    getOrCreateSession('example-session', null, 'web-example');
    const fullAuto = getOrCreateSession('fullauto-session', null, 'web-fullauto');
    updateSessionFullAuto(fullAuto.id, { enabled: true, prompt: 'Synthetic task' });
    startGatewayHttpServer().setReady();
  `,
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        PATH: process.env.PATH,
        HOME: root,
        HYBRIDCLAW_DATA_DIR: root,
        HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
        WEB_API_TOKEN: 'test-master',
        HYBRIDCLAW_AUTH_SECRET: 'test-secret',
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
      },
      stdio: 'pipe',
    },
  );
  let logs = '';
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  async function request(
    route = '/api/admin/approval-settings',
    method = 'GET',
    body?: unknown,
    token = 'test-master',
  ) {
    const res = await fetch(base + route, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.json() };
  }
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await request()).status;
          } catch {
            return 0;
          }
        },
        { timeout: 20_000, message: () => logs },
      )
      .toBe(200);
    const original = await request();
    expect(original.body.defaultMode).toBe('auto');
    const id = original.body.sessions.find((s: { channelId: string }) => s.channelId === 'web-example').id;
    const fullAuto = original.body.sessions.find((s: { channelId: string }) => s.channelId === 'web-fullauto');
    expect(fullAuto).toMatchObject({ storedMode: 'auto', effectiveMode: 'full' });
    const update = { target: 'default', mode: 'learning', expectedMode: 'auto' };
    expect((await request(undefined, 'GET', undefined, '')).status).toBe(401);
    for (const action of ['agent.runtime', 'admin.approvals.read']) {
      const token = await request('/api/admin/tokens', 'POST', { label: 'Example reader', claims: { actions: [action] } });
      expect(token.status).toBe(201);
      expect((await request(undefined, 'PUT', update, token.body.token)).status).toBe(403);
    }
    for (const invalid of [{}, { ...update, mode: 'invalid' }, { ...update, target: 'other' }, { ...update, expectedMode: null }, { ...update, target: 'session' }]) {
      expect((await request(undefined, 'PUT', invalid)).status).toBe(400);
    }
    expect((await request(undefined, 'PUT', { ...update, padding: 'x'.repeat(20_000) })).status).toBe(413);
    expect((await request(undefined, 'PUT', { ...update, target: 'session', sessionId: 'missing' })).status).toBe(404);
    const saved = await request(undefined, 'PUT', update);
    expect(saved.status).toBe(200);
    expect(saved.body.defaultMode).toBe('learning');
    expect((await request('/api/chat/context?sessionId=new-preview')).body.approvalMode).toBe('learning');
    expect((await request()).body.sessions).toHaveLength(2);
    expect(saved.body.sessions.every((s: { storedMode: string }) => s.storedMode === 'auto')).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).security.defaultApprovalMode).toBe('learning');
    expect((await request(undefined, 'PUT', { ...update, mode: 'ask' })).status).toBe(409);
    const sessionUpdate = { target: 'session', sessionId: id, mode: 'learning', expectedMode: 'auto' };
    const changed = await request(undefined, 'PUT', sessionUpdate);
    expect(changed.status).toBe(200);
    expect(changed.body.sessions.find((s: { id: string }) => s.id === id)).toMatchObject({ storedMode: 'learning', effectiveMode: 'learning' });
    expect((await request(undefined, 'PUT', { ...sessionUpdate, mode: 'full' })).status).toBe(409);
    const fullAutoChanged = await request(undefined, 'PUT', { ...sessionUpdate, sessionId: fullAuto.id });
    expect(fullAutoChanged.body.sessions.find((s: { id: string }) => s.id === fullAuto.id)).toMatchObject({ storedMode: 'learning', effectiveMode: 'learning' });
    await expect.poll(async () => (await request('/api/admin/audit?eventType=approval.mode_changed')).body.entries.length).toBe(2);
    const audit = await request('/api/admin/audit?eventType=approval.default_changed');
    expect(audit.body.entries).toHaveLength(1);
    expect(JSON.parse(audit.body.entries[0].payload)).toMatchObject({ from: 'auto', to: 'learning', actor: expect.any(String) });
    expect((await request('/api/admin/safety-rules')).body.disabledRuleIds).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
  }
}, 30_000);
