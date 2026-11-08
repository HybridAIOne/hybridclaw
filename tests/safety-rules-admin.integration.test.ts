import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { getAvailablePort } from './helpers/docker-test-setup.js';
import { useTempDir } from './test-utils.js';
const temp = useTempDir('safety-admin-');

test('authenticated admins review and change guards; scoped callers, invalid and stale writes cannot weaken them', async () => {
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
    import { initDatabase } from './src/memory/db.ts';
    import { startGatewayHttpServer } from './src/gateway/gateway-http-server.ts';
    initDatabase({quiet:true});
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
    route = '/api/admin/safety-rules',
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
    expect(original.body.disabledRuleIds).toEqual([]);
    expect(
      original.body.rules.find(
        (r: { id: string }) => r.id === 'recursive-delete',
      ),
    ).toMatchObject({
      enabled: true,
      scope: 'bash',
      pattern: expect.any(String),
    });
    expect((await request(undefined, 'GET', undefined, '')).status).toBe(401);
    for (const action of ['agent.runtime', 'admin.config.read']) {
      const token = await request('/api/admin/tokens', 'POST', {
        label: 'Test reader',
        claims: { actions: [action] },
      });
      expect(token.status).toBe(201);
      expect(
        (
          await request(
            undefined,
            'PUT',
            {
              disabledRuleIds: ['recursive-delete'],
              expectedDisabledRuleIds: [],
            },
            token.body.token,
          )
        ).status,
      ).toBe(403);
    }
    for (const invalid of [
      {},
      { disabledRuleIds: ['unknown'], expectedDisabledRuleIds: [] },
      { disabledRuleIds: null, expectedDisabledRuleIds: [] },
    ]) {
      expect((await request(undefined, 'PUT', invalid)).status).toBe(400);
    }
    expect(
      (
        await request(undefined, 'PUT', {
          disabledRuleIds: ['eval'],
          expectedDisabledRuleIds: [],
          padding: 'x'.repeat(20_000),
        })
      ).status,
    ).toBe(413);
    expect((await request()).body.disabledRuleIds).toEqual([]);
    const saved = await request(undefined, 'PUT', {
      disabledRuleIds: ['recursive-delete'],
      expectedDisabledRuleIds: [],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.disabledRuleIds).toEqual(['recursive-delete']);
    expect(
      JSON.parse(fs.readFileSync(configPath, 'utf8')).security
        .disabledSafetyRules,
    ).toEqual(['recursive-delete']);
    expect(
      (
        await request(undefined, 'PUT', {
          disabledRuleIds: ['eval'],
          expectedDisabledRuleIds: [],
        })
      ).status,
    ).toBe(409);
    expect((await request()).body.disabledRuleIds).toEqual([
      'recursive-delete',
    ]);
    await expect
      .poll(
        async () =>
          (await request('/api/admin/audit?eventType=safety.rules_changed'))
            .body.entries.length,
      )
      .toBe(1);
    const audit = await request(
      '/api/admin/audit?eventType=safety.rules_changed',
    );
    expect(JSON.parse(audit.body.entries[0].payload)).toMatchObject({
      previousDisabledRuleIds: [],
      disabledRuleIds: ['recursive-delete'],
    });
    const restored = await request(undefined, 'PUT', {
      disabledRuleIds: [],
      expectedDisabledRuleIds: ['recursive-delete'],
    });
    expect(restored.status).toBe(200);
    expect(
      restored.body.rules.every((r: { enabled: boolean }) => r.enabled),
    ).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
  }
}, 30_000);
