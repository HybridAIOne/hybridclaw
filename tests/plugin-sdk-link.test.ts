import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-plugin-sdk-link-');
const run = promisify(execFile);

function writeSdkImportingPlugin(cwd: string): void {
  const pluginDir = path.join(cwd, '.hybridclaw', 'plugins', 'sdk-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'hybridclaw.plugin.yaml'),
    'id: sdk-plugin\nname: SDK Plugin\nkind: channel\n',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'sdk-plugin', type: 'module' }),
  );
  // A value import, not a type: this only loads if the SDK resolves at runtime.
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    [
      "import { WebhookHttpError } from '@hybridaione/hybridclaw/plugin-sdk';",
      'export default {',
      "  id: 'sdk-plugin',",
      '  register(api) {',
      '    api.registerInboundWebhook({',
      "      name: 'inbound',",
      '      handler() {',
      "        throw new WebhookHttpError(401, 'Invalid signature.');",
      '      },',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
}

// Runs in a real `node --import tsx` process, as the gateway does in dev:
// vitest would hand the generated package to Node's loader without tsx.
const SCENARIO = `
import fs from 'node:fs';
import { Readable } from 'node:stream';
const { PluginManager } = await import(process.env.MANAGER_MODULE);
const { WebhookHttpError } = await import(process.env.WEBHOOK_HTTP_MODULE);
const config = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
config.plugins.list = [];
const manager = new PluginManager({
  homeDir: process.env.PLUGIN_HOME,
  cwd: process.env.PLUGIN_CWD,
  getRuntimeConfig: () => config,
});
await manager.ensureInitialized();
const summary = manager.listPluginSummary().find((p) => p.id === 'sdk-plugin');
const path = '/api/plugin-webhooks/sdk-plugin/inbound';
const req = Object.assign(Readable.from([]), { method: 'POST', url: path, headers: {} });
const res = { headersSent: false, writableEnded: false, setHeader() {}, end() {} };
let thrown = null;
try {
  await manager.handleInboundWebhook({
    method: 'POST', pathname: path, url: new URL('http://localhost' + path), req, res,
  });
} catch (error) {
  thrown = error;
}
await manager.shutdown();
console.log('RESULT ' + JSON.stringify({
  error: summary?.error ?? null,
  gatewayClass: thrown instanceof WebhookHttpError,
  status: thrown?.statusCode ?? null,
}));
`;

test('an installed plugin can import the plugin SDK at runtime and shares its classes', async () => {
  const cwd = makeTempDir();
  writeSdkImportingPlugin(cwd);
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', SCENARIO],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: makeTempDir(),
        MANAGER_MODULE: path.resolve('src/plugins/plugin-manager.ts'),
        WEBHOOK_HTTP_MODULE: path.resolve('src/channels/webhook-http.ts'),
        PLUGIN_HOME: makeTempDir(),
        PLUGIN_CWD: cwd,
      },
      timeout: 60_000,
    },
  );
  const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
  // The gateway maps the error to its status by class; a second SDK copy
  // would fail instanceof and turn the plugin's 401 into a 500.
  expect(JSON.parse(String(line).slice('RESULT '.length))).toEqual({
    error: null,
    gatewayClass: true,
    status: 401,
  });
}, 90_000);
