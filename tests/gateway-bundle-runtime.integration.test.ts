import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import WebSocket from 'ws';
import { nodePtyLoads } from './helpers/broken-node-pty.js';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { useTempDir } from './test-utils.js';

const REPO = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const makeTempDir = useTempDir('hc-gateway-bundle-');

// Exercise the real bundlers and the Dockerfile's gateway COPY instructions.
// The runtime fixture deliberately has no source tree or container/shared;
// keeping a working bundle beside broken tsc output must not satisfy this test.
async function buildRuntime(root: string): Promise<string> {
  const builder = path.join(root, 'builder');
  const runtime = path.join(root, 'runtime');
  for (const dir of [builder, runtime]) {
    fs.mkdirSync(dir);
    fs.copyFileSync(
      path.join(REPO, 'package.json'),
      path.join(dir, 'package.json'),
    );
  }
  fs.symlinkSync(
    path.join(REPO, 'node_modules'),
    path.join(builder, 'node_modules'),
    'dir',
  );
  const modules = path.join(runtime, 'node_modules');
  fs.mkdirSync(modules);
  for (const name of fs.readdirSync(path.join(REPO, 'node_modules'))) {
    const source = path.join(REPO, 'node_modules', name);
    const destination = path.join(modules, name);
    // The gateway repairs node-pty's executable helper. Keep that dependency
    // private to this fixture so the smoke test cannot chmod the checkout.
    if (name === 'node-pty')
      fs.cpSync(source, destination, { recursive: true });
    else fs.symlinkSync(source, destination);
  }
  fs.cpSync(path.join(REPO, 'src'), path.join(builder, 'src'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'tsconfig.json'), path.join(builder, 'tsconfig.json'));
  fs.cpSync(
    path.join(REPO, 'container/shared'),
    path.join(builder, 'container/shared'),
    { recursive: true },
  );
  await run(process.execPath, [path.join(REPO, 'scripts/bundle-gateway.mjs')], {
    cwd: builder,
    timeout: 30_000,
  });

  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  const runtimeStage = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
  const copies = [
    ...runtimeStage.matchAll(
      /^COPY .*--from=builder \/app\/(dist|bundle) \.\/([^\s]+)$/gm,
    ),
  ];
  expect(copies.length).toBeGreaterThan(0);
  for (const [, source, destination] of copies) {
    fs.cpSync(path.join(builder, source), path.join(runtime, destination), {
      recursive: true,
    });
  }
  for (const name of [
    'templates',
    'skills',
    'docs',
    'SECURITY.md',
    'TRUST_MODEL.md',
  ]) {
    fs.cpSync(path.join(REPO, name), path.join(runtime, name), {
      recursive: true,
    });
  }
  fs.cpSync(
    path.join(REPO, 'container/src'),
    path.join(builder, 'container/src'),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(REPO, 'container/package.json'),
    path.join(builder, 'container/package.json'),
  );
  await run(
    process.execPath,
    [path.join(REPO, 'container/scripts/bundle.mjs')],
    {
      cwd: path.join(builder, 'container'),
      timeout: 30_000,
    },
  );
  fs.cpSync(
    path.join(builder, 'container/dist'),
    path.join(runtime, 'container/dist'),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(builder, 'container/package.json'),
    path.join(runtime, 'container/package.json'),
  );
  return runtime;
}

async function stopGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

test('the image gateway, package CLI, and plugin SDK run without container/shared', async () => {
  const root = makeTempDir();
  const runtime = await buildRuntime(root);
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  const pluginDir = path.join(runtime, '.hybridclaw/plugins/sdk-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: sdk-plugin\nname: SDK Plugin\nkind: channel\n',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'sdk-plugin', type: 'module' }),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `
import { WebhookHttpError } from '@hybridaione/hybridclaw/plugin-sdk';
export default {
  id: 'sdk-plugin',
  register(api) {
    api.registerInboundWebhook({
      name: 'inbound',
      handler() { throw new WebhookHttpError(401, 'test'); },
    });
  },
};
`,
  );
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      ops: {
        healthPort: port,
        gatewayBaseUrl: baseUrl,
        gatewayInternalBaseUrl: baseUrl,
      },
      hybridai: { baseUrl: 'http://127.0.0.1:9' },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    HYBRIDCLAW_DATA_DIR: data,
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
    HYBRIDCLAW_ACCEPT_TRUST: 'true',
    HYBRIDAI_API_KEY: 'hai-test-placeholder',
    WEB_API_TOKEN: 'test-token',
  };
  expect(fs.existsSync(path.join(runtime, 'container/shared'))).toBe(false);
  expect(fs.existsSync(path.join(runtime, 'src'))).toBe(false);
  expect(fs.existsSync(path.join(runtime, 'bundle'))).toBe(false);

  // The package bin and embedded terminal both invoke this path, independently
  // of Docker's CMD. Loading it covers the dynamically imported CLI chunks too.
  const { bin } = JSON.parse(
    fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'),
  );
  await run(
    process.execPath,
    [path.join(runtime, bin.hybridclaw), 'help', 'gateway'],
    {
      cwd: runtime,
      env,
      timeout: 15_000,
    },
  );
  const sdk = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { WebhookHttpError } = await import('./dist/plugin-sdk.js'); console.log(new WebhookHttpError(401, 'test').statusCode);",
    ],
    { cwd: runtime, env, timeout: 15_000 },
  );
  expect(sdk.stdout.trim()).toBe('401');

  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  const command = JSON.parse(
    dockerfile.match(/^CMD (.+)$/m)?.[1] ?? 'null',
  ) as string[];
  expect(command[0]).toBe('node');
  expect(command[1]).toBe(bin.hybridclaw);
  const shellCli = dockerfile.match(/exec node \/app\/([^\s]+) /)?.[1];
  expect(shellCli).toBe(bin.hybridclaw);
  await run(
    process.execPath,
    [path.join(runtime, shellCli!), 'help', 'gateway'],
    {
      cwd: runtime,
      env,
      timeout: 15_000,
    },
  );
  let log = '';
  const child = spawn(
    process.execPath,
    [...command.slice(1), '--sandbox=host'],
    {
      cwd: runtime,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    log += chunk;
  });
  const exited = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Gateway exited (${code}): ${log}`)),
    );
  });
  try {
    await Promise.race([waitForHealth(`${baseUrl}/health`, 30_000), exited]);
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    // A plugin importing a second SDK instance would return 500 instead of 401.
    const webhook = await fetch(
      `${baseUrl}/api/plugin-webhooks/sdk-plugin/inbound`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      },
    );
    expect(webhook.status).toBe(401);
    // CI's integration job leaves node-pty unbuilt. When the native addon is
    // available, also exercise the real embedded terminal over its websocket.
    if (nodePtyLoads()) {
      const terminal = await fetch(`${baseUrl}/api/admin/terminal`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        signal: AbortSignal.timeout(5_000),
      });
      const started = (await terminal.json()) as {
        websocketPath: string;
        error?: string;
      };
      expect(terminal.status, started.error).toBe(200);
      const socket = new WebSocket(
        `${baseUrl.replace('http', 'ws')}${started.websocketPath}`,
      );
      let output = '';
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as {
          type: string;
          data?: string;
        };
        if (message.type === 'output') output += message.data ?? '';
      });
      try {
        await once(socket, 'open', { signal: AbortSignal.timeout(5_000) });
        socket.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
        const { version } = JSON.parse(
          fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'),
        );
        await expect.poll(() => output, { timeout: 15_000 }).toContain(version);
        const beforeHelp = output.length;
        socket.send(JSON.stringify({ type: 'input', data: '/help\r' }));
        await expect
          .poll(() => output.length, { timeout: 5_000 })
          .toBeGreaterThan(beforeHelp);
        expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
      } finally {
        socket.terminate();
      }
    }
    expect(child.exitCode).toBeNull();
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    await stopGateway(child);
  }
}, 90_000);
