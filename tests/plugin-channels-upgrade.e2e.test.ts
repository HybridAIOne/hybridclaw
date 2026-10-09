import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Full-binary e2e for plugin channels on a data dir upgraded from 0.39.1: the
// compiled gateway (host sandbox, isolated HOME and data dir) finds the LINE
// 0.1.0 plugin that no longer loads, a paired LINE session, and no WhatsApp
// plugin. Every surface must name the command that fixes it, and WhatsApp
// addresses must not fall through to another channel. Gated behind
// HYBRIDCLAW_RUN_CLI_E2E=1; needs `npm run build`.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const RUN = process.env.HYBRIDCLAW_RUN_CLI_E2E === '1' && fs.existsSync(CLI);
const WEB_API_TOKEN = 'e2e-plugin-channels-token';
const SELF_MID = `u${'c'.repeat(32)}`;
const REINSTALL_LINE = 'hybridclaw plugin reinstall line';
const INSTALL_WHATSAPP =
  'WhatsApp transport plugin is not installed. Install it with: hybridclaw plugin install';

const tempDirs: string[] = [];

function seedUpgradedDataDir(dataDir: string): void {
  const linePlugin = path.join(dataDir, 'plugins', 'line');
  fs.mkdirSync(linePlugin, { recursive: true });
  fs.writeFileSync(
    path.join(linePlugin, 'hybridclaw.plugin.yaml'),
    'id: line\nname: LINE\nversion: 0.1.0\nkind: channel\nentrypoint: index.js\n',
  );
  // What `plugin enable line` installed on 0.39.1: the transport factory only.
  fs.writeFileSync(
    path.join(linePlugin, 'index.js'),
    "export default { id: 'line', register(api) { api.registerChannelTransport({ kind: 'line', create() { throw new Error('unused'); } }); } };\n",
  );
  const lineAuth = path.join(dataDir, 'credentials', 'line');
  fs.mkdirSync(lineAuth, { recursive: true });
  fs.writeFileSync(
    path.join(lineAuth, 'storage.json'),
    JSON.stringify({
      '.hybridclaw:authToken': 'test-token',
      '.hybridclaw:profileMid': SELF_MID,
    }),
  );
}

describe.skipIf(!RUN)('plugin channels after an upgrade from 0.39.1', () => {
  let gateway: ChildProcess | null = null;
  let log = '';
  let baseUrl = '';
  let env: NodeJS.ProcessEnv = {};
  let dataDir = '';

  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-plugin-channels-'));
    tempDirs.push(root);
    const home = path.join(root, 'home');
    dataDir = path.join(root, 'data');
    fs.mkdirSync(home);
    fs.mkdirSync(dataDir);
    const port = await getAvailablePort(
      Number(process.env.HYBRIDCLAW_E2E_PORT) || undefined,
    );
    baseUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        ops: { healthPort: port, webApiToken: WEB_API_TOKEN },
        container: { sandboxMode: 'host' },
        // Unroutable so the gateway never calls the hosted HybridAI API.
        hybridai: { baseUrl: 'http://127.0.0.1:9' },
        line: { enabled: true },
      }),
    );
    seedUpgradedDataDir(dataDir);
    env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      HYBRIDCLAW_DATA_DIR: dataDir,
      HYBRIDCLAW_ACCEPT_TRUST: 'true',
      HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
    };
    gateway = spawn(
      process.execPath,
      [CLI, 'gateway', 'start', '--foreground', '--sandbox=host'],
      // A neutral cwd: a checkout's ./plugins would shadow the data dir's.
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    gateway.stdout?.on('data', (chunk) => {
      log += chunk;
    });
    gateway.stderr?.on('data', (chunk) => {
      log += chunk;
    });
    try {
      await waitForHealth(`${baseUrl}/health`, 45_000);
    } catch (error) {
      console.error('--- gateway log ---\n', log);
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    const child = gateway;
    gateway = null;
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    cleanupTrackedTempDirs(tempDirs);
  }, 20_000);

  async function sendMessage(channelId: string) {
    const response = await fetch(`${baseUrl}/api/message/action`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WEB_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'send', channelId, content: 'hello' }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { error?: string },
    };
  }

  test('status, the gateway log, and doctor point the stale LINE plugin at reinstall', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${WEB_API_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      channelPlugins: Array<Record<string, unknown>>;
      line?: Record<string, unknown>;
    };
    expect(status.channelPlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'line',
          transportAvailable: false,
          loadFailed: true,
        }),
        expect.objectContaining({
          channel: 'whatsapp',
          transportAvailable: false,
          loadFailed: false,
        }),
      ]),
    );
    expect(status.line).toMatchObject({ linked: false });
    expect(log).toContain(
      `LINE integration disabled: LINE transport plugin failed to load (see \`hybridclaw plugin list\`). Reinstall it with: ${REINSTALL_LINE}`,
    );

    const doctor = spawnSync(process.execPath, [CLI, 'doctor', 'channels'], {
      cwd: path.dirname(dataDir),
      env,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(doctor.stdout).toContain(REINSTALL_LINE);
    expect(doctor.stdout).not.toContain('LINE plugin not installed');
    expect(doctor.status).toBe(1);
  });

  test('a LINE send fails with the reinstall command and leaves the pairing', async () => {
    const { status, body } = await sendMessage(`line:${SELF_MID}`);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toContain(REINSTALL_LINE);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(dataDir, 'credentials', 'line', 'storage.json'),
          'utf-8',
        ),
      ),
    ).toHaveProperty(['.hybridclaw:profileMid'], SELF_MID);
  });

  test.each([
    '+491701234567',
    'whatsapp:+491701234567',
    'whatsapp:+49 170 1234567',
    '491701234567@s.whatsapp.net',
  ])('WhatsApp target %s stays on WhatsApp and names the install command', async (channelId) => {
    const { status, body } = await sendMessage(channelId);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toContain(INSTALL_WHATSAPP);
  });
});
