import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePluginDir(dir: string, options?: { packageName?: string }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      'id: demo-plugin',
      'name: Demo Plugin',
      'version: 1.0.0',
      'kind: tool',
      'requires:',
      '  env: [DEMO_PLUGIN_KEY]',
      'configSchema:',
      '  type: object',
      '  properties:',
      '    workspaceId:',
      '      type: string',
      '  required: [workspaceId]',
      'install:',
      '  - kind: npm',
      `    package: "${options?.packageName || '@scope/demo-plugin-dep'}"`,
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "export default { id: 'demo-plugin', register() {} };\n",
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: options?.packageName || '@scope/demo-plugin',
        version: '1.0.0',
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

function writeManifestOnlyPluginDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      'id: manifest-only-plugin',
      'name: Manifest Only Plugin',
      'version: 1.0.0',
      'kind: tool',
      'install:',
      '  - kind: npm',
      '    package: "@scope/manifest-only-dep"',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "export default { id: 'manifest-only-plugin', register() {} };\n",
    'utf-8',
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugin install', () => {
  test('installs a local plugin directory into ~/.hybridclaw/plugins', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'demo-plugin');
    writePluginDir(sourceDir);
    fs.mkdirSync(path.join(sourceDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'node_modules', 'ignored.txt'),
      'ignore me\n',
      'utf-8',
    );
    fs.mkdirSync(path.join(sourceDir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, '.git', 'config'),
      '[core]\n',
      'utf-8',
    );

    const runCommand = vi.fn();
    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
    });

    const installedDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'demo-plugin',
    );
    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir: installedDir,
      source: sourceDir,
      alreadyInstalled: false,
      dependenciesInstalled: true,
      requiresEnv: ['DEMO_PLUGIN_KEY'],
      requiredConfigKeys: ['workspaceId'],
    });
    expect(
      fs.existsSync(path.join(installedDir, 'hybridclaw.plugin.yaml')),
    ).toBe(true);
    expect(fs.existsSync(path.join(installedDir, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(installedDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(installedDir, '.git'))).toBe(false);
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm',
        args: [
          'install',
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
        ],
      }),
    );
  });

  test('installs a plugin from an npm spec via a staged npm fetch', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');

    const runCommand = vi.fn(
      ({
        args,
        cwd: commandCwd,
      }: {
        command: string;
        args: string[];
        cwd: string;
      }) => {
        if (args.includes('--ignore-scripts')) {
          const packageDir = path.join(
            commandCwd,
            'node_modules',
            '@scope',
            'demo-plugin',
          );
          writePluginDir(packageDir, { packageName: '@scope/demo-plugin' });
        }
      },
    );

    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin('@scope/demo-plugin', {
      homeDir,
      cwd,
      runCommand,
    });

    const installedDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'demo-plugin',
    );
    expect(result.pluginId).toBe('demo-plugin');
    expect(result.pluginDir).toBe(installedDir);
    expect(result.alreadyInstalled).toBe(false);
    expect(result.dependenciesInstalled).toBe(true);
    expect(
      fs.existsSync(path.join(installedDir, 'hybridclaw.plugin.yaml')),
    ).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: 'npm',
        args: [
          'install',
          '--ignore-scripts',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '@scope/demo-plugin',
        ],
      }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'npm',
        args: [
          'install',
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
        ],
      }),
    );
  });

  test('installs manifest-declared npm packages with scripts disabled when no package.json is present', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'manifest-only-plugin');
    writeManifestOnlyPluginDir(sourceDir);

    const runCommand = vi.fn();
    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
    });

    const installedDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'manifest-only-plugin',
    );
    expect(result).toEqual({
      pluginId: 'manifest-only-plugin',
      pluginDir: installedDir,
      source: sourceDir,
      alreadyInstalled: false,
      dependenciesInstalled: true,
      requiresEnv: [],
      requiredConfigKeys: [],
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm',
        args: [
          'install',
          '--ignore-scripts',
          '--omit=dev',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '@scope/manifest-only-dep',
        ],
      }),
    );
  });

  test('reinstalls a local plugin directory without removing config overrides', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'demo-plugin');
    writePluginDir(sourceDir);

    const installedDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'demo-plugin',
    );
    writePluginDir(installedDir, { packageName: '@scope/old-demo-plugin' });
    fs.writeFileSync(
      path.join(installedDir, 'stale.txt'),
      'old build artifact\n',
      'utf-8',
    );

    const config = {
      plugins: {
        list: [
          { id: 'demo-plugin', enabled: true, config: { workspaceId: 'a' } },
        ],
      },
    } as RuntimeConfig;

    const runCommand = vi.fn();
    const { reinstallPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );
    const result = await reinstallPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
    });

    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir: installedDir,
      source: sourceDir,
      alreadyInstalled: false,
      replacedExistingInstall: true,
      dependenciesInstalled: true,
      requiresEnv: ['DEMO_PLUGIN_KEY'],
      requiredConfigKeys: ['workspaceId'],
    });
    expect(fs.existsSync(path.join(installedDir, 'stale.txt'))).toBe(false);
    expect(config.plugins.list).toEqual([
      { id: 'demo-plugin', enabled: true, config: { workspaceId: 'a' } },
    ]);
  });

  test('uninstalls a home plugin and removes matching runtime config overrides', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const pluginDir = path.join(
      homeDir,
      '.hybridclaw',
      'plugins',
      'demo-plugin',
    );
    writePluginDir(pluginDir);

    let config = {
      plugins: {
        list: [
          { id: 'demo-plugin', enabled: true, config: { workspaceId: 'a' } },
          { id: 'other-plugin', enabled: true, config: {} },
          { id: 'demo-plugin', enabled: false, config: {} },
        ],
      },
    } as RuntimeConfig;

    const getRuntimeConfig = () => structuredClone(config);
    const updateRuntimeConfig = vi.fn(
      (mutator: (draft: RuntimeConfig) => void) => {
        const draft = structuredClone(config);
        mutator(draft);
        config = draft;
        return structuredClone(config);
      },
    );

    const { uninstallPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );
    const result = await uninstallPlugin('demo-plugin', {
      homeDir,
      getRuntimeConfig,
      updateRuntimeConfig,
    });

    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir,
      removedPluginDir: true,
      removedConfigOverrides: 2,
    });
    expect(fs.existsSync(pluginDir)).toBe(false);
    expect(config.plugins.list).toEqual([
      { id: 'other-plugin', enabled: true, config: {} },
    ]);
    expect(updateRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  test('uninstalls config-only plugin overrides when no home plugin directory exists', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    let config = {
      plugins: {
        list: [{ id: 'demo-plugin', enabled: true, config: {} }],
      },
    } as RuntimeConfig;

    const { uninstallPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );
    const result = await uninstallPlugin('demo-plugin', {
      homeDir,
      getRuntimeConfig: () => structuredClone(config),
      updateRuntimeConfig: (mutator) => {
        const draft = structuredClone(config);
        mutator(draft);
        config = draft;
        return structuredClone(config);
      },
    });

    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir: path.join(homeDir, '.hybridclaw', 'plugins', 'demo-plugin'),
      removedPluginDir: false,
      removedConfigOverrides: 1,
    });
    expect(config.plugins.list).toEqual([]);
  });

  test('rejects invalid plugin ids during uninstall', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const { uninstallPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );

    await expect(
      uninstallPlugin('../demo-plugin', {
        homeDir,
      }),
    ).rejects.toThrow('Invalid plugin id');
  });
});
