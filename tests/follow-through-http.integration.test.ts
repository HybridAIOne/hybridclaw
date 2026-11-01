import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { useTempDir } from './test-utils.js';

const directory = useTempDir('hy-follow-http-');
const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');

test('the owner phone refreshes its overview; forged operators cannot read or change it', async () => {
  const root = directory();
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  for (const name of [
    'src',
    'scripts',
    'container',
    'templates',
    'skills',
    'docs',
    'package.json',
    'tsconfig.json',
    'SECURITY.md',
    'TRUST_MODEL.md',
  ]) {
    fs.cpSync(path.join(repo, name), path.join(runtime, name), {
      recursive: true,
      filter: (source) =>
        !['node_modules', 'dist'].includes(path.basename(source)),
    });
  }
  fs.symlinkSync(
    path.join(repo, 'node_modules'),
    path.join(runtime, 'node_modules'),
    'dir',
  );
  fs.symlinkSync(
    path.join(repo, 'container/node_modules'),
    path.join(runtime, 'container/node_modules'),
    'dir',
  );
  const port = await getAvailablePort();
  const base = `http://127.0.0.1:${port}`;
  const secret = 'test-handoff-secret';
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      ops: {
        healthPort: port,
        gatewayBaseUrl: base,
        gatewayInternalBaseUrl: base,
      },
      hybridai: { baseUrl: 'http://127.0.0.1:9' },
    }),
  );
  await run(process.execPath, ['scripts/bundle-gateway.mjs'], {
    cwd: runtime,
    timeout: 30_000,
  });
  await run(process.execPath, ['scripts/bundle.mjs'], {
    cwd: path.join(runtime, 'container'),
    timeout: 30_000,
  });
  const child = spawn(
    process.execPath,
    ['dist/cli.js', 'gateway', 'start', '--foreground', '--sandbox=host'],
    {
      cwd: runtime,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        HYBRIDCLAW_DATA_DIR: root,
        HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
        HYBRIDAI_API_KEY: 'hai-test-placeholder',
        WEB_API_TOKEN: 'test-master',
        HYBRIDCLAW_AUTH_SECRET: secret,
      },
      stdio: 'pipe',
    },
  );
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  const post = async (route: string, body: object, token = 'test-master') => {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const chat = (content: string, token?: string, operatorId?: string) =>
    post(
      '/api/chat',
      {
        content,
        sessionId: 'phone-home',
        userId: 'account-a',
        channelId: 'web',
        client: 'mobile',
        operatorId,
      },
      token,
    );
  try {
    await waitForHealth(base + '/health', 15_000).catch((error) => {
      throw new Error(logs, { cause: error });
    });
    const created = await chat('/track add --json Arrange a visit');
    expect(created.status, logs).toBe(200);
    const item = JSON.parse(created.body.result).item;
    const segment = Buffer.from(
      JSON.stringify({
        sub: 'account-a',
        jti: 'phone-pass',
        typ: 'device-handoff',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const pass = `${segment}.${createHmac('sha256', secret).update(segment).digest('base64url')}`;
    const phone = await post('/api/device/handoff', {
      handoff: pass,
      client_name: 'Test phone',
    });
    expect(phone.status).toBe(200);
    const token = phone.body.access_token;
    for (let refresh = 0; refresh < 2; refresh++) {
      const overview = await chat(
        '/track overview --json',
        token,
        'forged-operator',
      );
      expect(overview.status).toBe(200);
      expect(JSON.parse(overview.body.result).items).toMatchObject([
        { id: item.id, title: 'Arrange a visit' },
      ]);
    }
    const command = await post('/api/command', {
      sessionId: 'phone-home',
      userId: 'account-a',
      args: ['track', 'get', String(item.id), '--json'],
    });
    expect(command.status).toBe(200);
    expect(JSON.parse(command.body.text).item.id).toBe(item.id);
    const other = await post('/api/admin/tokens', {
      label: 'Other caller',
      claims: { actions: ['chat.send'] },
    });
    expect(other.status).toBe(201);
    const forged = createHash('sha256').update('local-operator').digest('hex');
    const denied = await chat(
      '/track overview --json',
      other.body.token,
      forged,
    );
    expect(denied.body.result).toContain('another user');
    const changed = Buffer.from(
      JSON.stringify({
        action: 'complete',
        revision: item.revision,
        request_id: 'foreign-change',
        done: true,
      }),
    ).toString('base64url');
    const update = await chat(
      `/track update ${item.id} ${changed} --json`,
      other.body.token,
    );
    expect(update.body.result).toContain('another user');
    expect(
      JSON.parse((await chat('/track overview --json', token)).body.result)
        .items[0].phase,
    ).toBe('in_progress');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}, 60_000);
