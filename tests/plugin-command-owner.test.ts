import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { normalizeManifestCommands } from '../src/plugins/plugin-cli-commands.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

// A gateway slash command whose plugin is not loaded names the plugin and
// what to run, from the manifest's `commands`, instead of "Unknown command".
const makeTempDir = useTempDir('hybridclaw-plugin-command-owner-');
useCleanMocks({ unstubAllEnvs: true, resetModules: true });

function useHome(config?: unknown): string {
  const home = makeTempDir();
  vi.stubEnv('HOME', home);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  if (config) {
    fs.mkdirSync(path.join(home, '.hybridclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.hybridclaw', 'config.json'),
      JSON.stringify(config),
    );
  }
  vi.resetModules();
  return home;
}

test.each([
  ['a non-list', 'voice', /must be a list/],
  ['a bad name', ['Voice'], /lowercase/],
  ['a duplicate', ['voice', 'voice'], /twice/],
])('manifest commands rejects %s', (_label, value, message) => {
  expect(() => normalizeManifestCommands('demo', value)).toThrow(message);
});

test.each([
  [
    'a bundled plugin that is not installed',
    'voice',
    undefined,
    /`\/voice` is provided by the bundled "twilio-voice" plugin, which is not installed\. Install it with `hybridclaw plugin install twilio-voice`/,
  ],
  [
    'a disabled plugin',
    'vonage',
    { plugins: { list: [{ id: 'vonage-voice', enabled: false }] } },
    /"vonage-voice" plugin, which is disabled\. Enable it with `hybridclaw plugin enable vonage-voice`/,
  ],
  [
    'an enabled plugin that did not load',
    'browser-pool',
    { plugins: { list: [{ id: 'managed-cloud', enabled: true }] } },
    /"managed-cloud" plugin, which did not load: run `hybridclaw plugin check managed-cloud`/,
  ],
])('a command of %s names the plugin and the fix', async (_label, name, config, expected) => {
  useHome(config);
  const { describeMissingPluginCommand } = await import(
    '../src/gateway/gateway-plugin-command-hint.js'
  );
  expect(await describeMissingPluginCommand(name)).toMatch(expected);
});

test('a command no manifest declares gets no hint', async () => {
  useHome();
  const { describeMissingPluginCommand } = await import(
    '../src/gateway/gateway-plugin-command-hint.js'
  );
  expect(await describeMissingPluginCommand('no-such-command')).toBeNull();
});

test('a plugin cannot register a slash command its manifest does not declare', async () => {
  const home = useHome();
  const { getRuntimeConfig } = await import('../src/config/runtime-config.js');
  const { getPluginManager } = await import('../src/plugins/plugin-manager.js');
  const { createPluginApi } = await import('../src/plugins/plugin-api.js');
  const manager = getPluginManager();
  const api = (declaredCommands?: string[]) =>
    createPluginApi({
      manager,
      pluginId: 'demo',
      pluginDir: home,
      registrationMode: 'full',
      config: getRuntimeConfig(),
      pluginConfig: {},
      declaredEnv: [],
      declaredCommands,
      homeDir: home,
      cwd: home,
    });
  const command = (name: string) => ({ name, handler: () => 'ok' });

  expect(() => api(['demo']).registerCommand(command('other'))).toThrow(
    /"other" is not declared in the manifest's `commands`/,
  );
  api(['demo']).registerCommand(command('demo'));
  api(undefined).registerCommand(command('undeclared'));
  expect(manager.findCommand('demo')).toBeDefined();
  expect(manager.findCommand('undeclared')).toBeDefined();
  expect(manager.findCommand('other')).toBeUndefined();
});
