import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { validatePluginConfig } from '../src/plugins/plugin-config-validation.ts';
import { loadPluginManifest } from '../src/plugins/plugin-manager.ts';
import { V0_39_1_BROWSER } from './fixtures/v0-39-1-browser-config.ts';
import { useCleanMocks, useTempDir } from './test-utils.ts';

// compat: remove after v0.41 together with legacy-browser-plugin-migration.ts.

const ROOT = path.resolve(import.meta.dirname, '..');

describe('legacy browser section import', () => {
  const makeTempDir = useTempDir('hybridclaw-legacy-browser-');
  useCleanMocks({ restoreAllMocks: true, resetModules: true, unstubAllEnvs: true });

  async function loadUpgraded(browser: Record<string, unknown>) {
    const dataDir = makeTempDir();
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ version: 40, browser }),
    );
    vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.resetModules();
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    return runtimeConfig.getRuntimeConfig();
  }

  test.each([
    { provider: 'browser-use-cloud', config: {} },
    { provider: 'managed-cloud', config: { endpointUrl: 'http://127.0.0.1:8787' } },
    { provider: 'camofox', config: { headed: false, launchOptions: {} } },
    {
      provider: 'mac-cua',
      config: { browser: 'chrome', driverArgs: [], screenshotMode: 'som' },
    },
  ])('a real v0.39.1 $provider config enables the plugin without its unset placeholders', async ({
    provider,
    config,
  }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadUpgraded({ ...V0_39_1_BROWSER, provider });

    expect(loaded.browser.provider).toBe(provider);
    expect(loaded.plugins.list).toEqual([{ id: provider, enabled: true, config }]);
    // The plugin loads the imported config with its own defaults filled in.
    const manifest = loadPluginManifest(
      path.join(ROOT, 'plugins', provider, 'hybridclaw.plugin.yaml'),
    );
    expect(() => validatePluginConfig(manifest.configSchema, config)).not.toThrow();
  });

  test('keeps browser-use-cloud values the operator chose', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadUpgraded({
      provider: 'browser-use-cloud',
      browserUseCloud: {
        baseUrl: 'https://browser-use.example/api/v4',
        browser: { timeoutMinutes: 30, browserScreenWidth: 1280, browserScreenHeight: 1 },
        pricing: { browserUsdPerMinute: 0.001, actionUsd: 0 },
      },
    });

    expect(loaded.plugins.list[0]?.config).toEqual({
      baseUrl: 'https://browser-use.example/api/v4',
      browser: { timeoutMinutes: 30, browserScreenWidth: 1280 },
      pricing: { browserUsdPerMinute: 0.001 },
    });
  });

  test('names the install step camofox still needs after the import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await loadUpgraded({ ...V0_39_1_BROWSER, provider: 'camofox' });

    const notice = warn.mock.calls.map(([message]) => String(message)).join('\n');
    expect(notice).toContain('hybridclaw plugin install camofox');
    expect(notice).toContain('npx camoufox-js fetch');
  });
});
