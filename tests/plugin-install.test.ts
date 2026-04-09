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

function writePluginDir(
  dir: string,
  options?: { packageName?: string; pluginId?: string; pluginName?: string },
): void {
  const pluginId = options?.pluginId || 'demo-plugin';
  const pluginName = options?.pluginName || 'Demo Plugin';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      `id: ${pluginId}`,
      `name: ${pluginName}`,
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
    `export default { id: '${pluginId}', register() {} };\n`,
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

function writePluginDirWithMissingBin(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      'id: bin-plugin',
      'name: Bin Plugin',
      'version: 1.0.0',
      'kind: tool',
      'requires:',
      '  bins:',
      '    - name: mempalace',
      '      configKey: command',
      '      installHint: pip install mempalace',
      '      installUrl: https://github.com/milla-jovovich/mempalace',
      'configSchema:',
      '  type: object',
      '  properties:',
      '    command:',
      '      type: string',
      '      default: mempalace',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "export default { id: 'bin-plugin', register() {} };\n",
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@scope/bin-plugin',
        version: '1.0.0',
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

function writePipPluginDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    [
      'id: pip-plugin',
      'name: Pip Plugin',
      'version: 1.0.0',
      'kind: tool',
      'requires:',
      '  bins:',
      '    - name: mempalace',
      '      configKey: command',
      '      installHint: pip install mempalace',
      '      installUrl: https://github.com/milla-jovovich/mempalace',
      'pipDependencies:',
      '  - mempalace',
      'externalDependencies:',
      '  - name: mempalace',
      '    check: mempalace --version',
      '    installHint: pip install mempalace',
      '    installUrl: https://github.com/milla-jovovich/mempalace',
      'configSchema:',
      '  type: object',
      '  properties:',
      '    command:',
      '      type: string',
      '      default: mempalace',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "export default { id: 'pip-plugin', register() {} };\n",
    'utf-8',
  );
}

function createRuntimeConfigState(initial?: RuntimeConfig): {
  getRuntimeConfig: () => RuntimeConfig;
  updateRuntimeConfig: ReturnType<typeof vi.fn>;
  read: () => RuntimeConfig;
} {
  let config =
    initial ||
    ({
      plugins: {
        list: [],
      },
    } as RuntimeConfig);
  const getRuntimeConfig = () => structuredClone(config);
  const updateRuntimeConfig = vi.fn(
    (mutator: (draft: RuntimeConfig) => void) => {
      const draft = structuredClone(config);
      mutator(draft);
      config = draft;
      return structuredClone(config);
    },
  );
  return {
    getRuntimeConfig,
    updateRuntimeConfig,
    read: () => structuredClone(config),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugin install', () => {
  test('installs a local plugin directory into homeDir/plugins', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'demo-plugin');
    const runtimeConfig = createRuntimeConfigState();
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
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    const installedDir = path.join(homeDir, 'plugins', 'demo-plugin');
    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir: installedDir,
      source: sourceDir,
      alreadyInstalled: false,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: ['@scope/demo-plugin-dep'],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
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
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '@scope/demo-plugin-dep',
        ],
      }),
    );
  });

  test('installs a plugin from an npm spec via a staged npm fetch', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const runtimeConfig = createRuntimeConfigState();

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
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    const installedDir = path.join(homeDir, 'plugins', 'demo-plugin');
    expect(result.pluginId).toBe('demo-plugin');
    expect(result.pluginDir).toBe(installedDir);
    expect(result.alreadyInstalled).toBe(false);
    expect(result.dependenciesInstalled).toBe(true);
    expect(result.dependencySummary).toEqual({
      usedPackageJson: false,
      installedNodePackages: ['@scope/demo-plugin'],
      installedPipPackages: [],
    });
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
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '@scope/demo-plugin',
        ],
      }),
    );
  });

  test('resolves a bare plugin id from cwd/plugins before falling back to npm', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'plugins', 'mempalace-memory');
    const runtimeConfig = createRuntimeConfigState();
    writePluginDir(sourceDir, {
      pluginId: 'mempalace-memory',
      pluginName: 'MemPalace Memory',
      packageName: '@scope/mempalace-memory',
    });

    const runCommand = vi.fn();
    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin('mempalace-memory', {
      homeDir,
      cwd,
      runCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    expect(result.pluginId).toBe('mempalace-memory');
    expect(result.pluginDir).toBe(
      path.join(homeDir, 'plugins', 'mempalace-memory'),
    );
    expect(result.source).toBe('mempalace-memory');
    expect(runCommand).toHaveBeenCalledTimes(1);
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
          '@scope/mempalace-memory',
        ],
      }),
    );
  });

  test('installs manifest-declared npm packages with scripts disabled when no package.json is present', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'manifest-only-plugin');
    const runtimeConfig = createRuntimeConfigState();
    writeManifestOnlyPluginDir(sourceDir);

    const runCommand = vi.fn();
    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    const installedDir = path.join(homeDir, 'plugins', 'manifest-only-plugin');
    expect(result).toEqual({
      pluginId: 'manifest-only-plugin',
      pluginDir: installedDir,
      source: sourceDir,
      alreadyInstalled: false,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: ['@scope/manifest-only-dep'],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
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

  test('reports missing required binaries after install', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'bin-plugin');
    const runtimeConfig = createRuntimeConfigState();
    writePluginDirWithMissingBin(sourceDir);

    const runCommand = vi.fn();
    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    expect(result.missingRequiredBins).toEqual([
      {
        name: 'mempalace',
        command: 'mempalace',
        configKey: 'command',
        installHint: 'pip install mempalace',
        installUrl: 'https://github.com/milla-jovovich/mempalace',
      },
    ]);
  });

  test('requires explicit approval before installing plugin dependencies', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'demo-plugin');
    const runtimeConfig = createRuntimeConfigState();
    writePluginDir(sourceDir);

    const runCommand = vi.fn();
    const { installPlugin, PluginDependencyApprovalRequiredError } =
      await import('../src/plugins/plugin-install.js');

    await expect(
      installPlugin(sourceDir, {
        homeDir,
        cwd,
        runCommand,
        getRuntimeConfig: runtimeConfig.getRuntimeConfig,
        updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyApprovalRequiredError);
    expect(runCommand).not.toHaveBeenCalled();
  });

  test('installs pip dependencies, auto-configures local binaries, and checks the plugin', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'pip-plugin');
    const runtimeConfig = createRuntimeConfigState();
    writePipPluginDir(sourceDir);

    const runCommand = vi.fn(
      ({
        command,
        args,
        cwd: commandCwd,
      }: {
        command: string;
        args: string[];
        cwd: string;
      }) => {
        if (command === 'uv' && args[0] === 'venv') {
          const binDir = path.join(commandCwd, '.venv', 'bin');
          fs.mkdirSync(binDir, { recursive: true });
          fs.writeFileSync(
            path.join(binDir, 'python'),
            '#!/bin/sh\nexit 0\n',
            'utf-8',
          );
          fs.chmodSync(path.join(binDir, 'python'), 0o755);
          return;
        }
        if (command === 'uv' && args[0] === 'pip') {
          const binDir = path.join(commandCwd, '.venv', 'bin');
          fs.mkdirSync(binDir, { recursive: true });
          fs.writeFileSync(
            path.join(binDir, 'mempalace'),
            `#!${path.join(commandCwd, '.venv', 'bin', 'python')}\n`,
            'utf-8',
          );
          fs.chmodSync(path.join(binDir, 'mempalace'), 0o755);
        }
      },
    );
    const runCheckCommand = vi.fn(
      ({
        command,
        args,
        shellCommand,
      }: {
        command?: string;
        args?: string[];
        cwd: string;
        shellCommand?: string;
      }) => {
        if (command === 'uv' && args?.[0] === '--version') {
          return { ok: true, status: 0, signal: null };
        }
        if (
          typeof command === 'string' &&
          command.endsWith(path.join('.venv', 'bin', 'python')) &&
          args?.[0] === '-m' &&
          args?.[1] === 'pip' &&
          args?.[2] === 'show' &&
          args?.[3] === 'mempalace'
        ) {
          return { ok: true, status: 0, signal: null };
        }
        if (shellCommand === 'mempalace --version') {
          return { ok: true, status: 0, signal: null };
        }
        return { ok: false, status: 1, signal: null };
      },
    );

    const { checkPlugin, installPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );
    const installResult = await installPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
      runCheckCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    expect(installResult.dependencySummary).toEqual({
      usedPackageJson: false,
      installedNodePackages: [],
      installedPipPackages: ['mempalace'],
    });
    expect(installResult.configuredRequiredBins).toEqual([
      {
        name: 'mempalace',
        configKey: 'command',
        command: path.join(
          homeDir,
          'plugins',
          'pip-plugin',
          '.venv',
          'bin',
          'mempalace',
        ),
      },
    ]);
    expect(runtimeConfig.read().plugins.list).toEqual([
      {
        id: 'pip-plugin',
        enabled: true,
        config: {
          command: path.join(
            homeDir,
            'plugins',
            'pip-plugin',
            '.venv',
            'bin',
            'mempalace',
          ),
        },
      },
    ]);
    expect(
      fs
        .readFileSync(
          path.join(
            homeDir,
            'plugins',
            'pip-plugin',
            '.venv',
            'bin',
            'mempalace',
          ),
          'utf-8',
        )
        .split('\n')[0],
    ).toBe(
      `#!${path.join(homeDir, 'plugins', 'pip-plugin', '.venv', 'bin', 'python')}`,
    );

    const checkResult = await checkPlugin('pip-plugin', {
      homeDir,
      cwd,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      runCheckCommand,
    });

    expect(checkResult.pipDependencies).toEqual([
      { package: 'mempalace', installed: true },
    ]);
    expect(checkResult.externalDependencies).toEqual([
      {
        name: 'mempalace',
        check: 'mempalace --version',
        installed: true,
        installHint: 'pip install mempalace',
        installUrl: 'https://github.com/milla-jovovich/mempalace',
      },
    ]);
    expect(checkResult.configuredRequiredBins).toEqual([
      {
        name: 'mempalace',
        configKey: 'command',
        command: path.join(
          homeDir,
          'plugins',
          'pip-plugin',
          '.venv',
          'bin',
          'mempalace',
        ),
      },
    ]);
    expect(checkResult.missingRequiredBins).toBeUndefined();
  });

  test('rejects shell operators in manifest external dependency checks', async () => {
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const { defaultPluginDependencyCheckCommand } = await import(
      '../src/plugins/plugin-dependencies.js'
    );

    const result = defaultPluginDependencyCheckCommand({
      cwd,
      shellCommand: 'mempalace --version && echo hacked',
    });

    expect(result).toEqual({
      ok: false,
      status: null,
      signal: null,
      error:
        'Unsupported external dependency check command; use a simple executable and arguments without shell operators.',
    });
  });

  test('parses simple external dependency checks without using a shell', async () => {
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const { defaultPluginDependencyCheckCommand } = await import(
      '../src/plugins/plugin-dependencies.js'
    );

    const result = defaultPluginDependencyCheckCommand({
      cwd,
      shellCommand: `"${process.execPath}" --version`,
    });

    expect(result).toEqual({
      ok: true,
      status: 0,
      signal: null,
    });
  });

  test('recomputes dependency plan for an already-installed plugin directory', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const installedDir = path.join(homeDir, 'plugins', 'manifest-only-plugin');
    const runtimeConfig = createRuntimeConfigState();
    writeManifestOnlyPluginDir(installedDir);

    const runCommand = vi.fn();
    const { installPlugin } = await import('../src/plugins/plugin-install.js');
    const result = await installPlugin(installedDir, {
      homeDir,
      cwd: makeTempDir('hybridclaw-plugin-cwd-'),
      runCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    expect(result).toEqual({
      pluginId: 'manifest-only-plugin',
      pluginDir: installedDir,
      source: installedDir,
      alreadyInstalled: true,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: ['@scope/manifest-only-dep'],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
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
        cwd: installedDir,
      }),
    );
  });

  test('reinstalls a local plugin directory without removing config overrides', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const sourceDir = path.join(cwd, 'demo-plugin');
    writePluginDir(sourceDir);

    const installedDir = path.join(homeDir, 'plugins', 'demo-plugin');
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
    const runtimeConfig = createRuntimeConfigState(config);

    const runCommand = vi.fn();
    const { reinstallPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );
    const result = await reinstallPlugin(sourceDir, {
      homeDir,
      cwd,
      runCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir: installedDir,
      source: sourceDir,
      alreadyInstalled: false,
      replacedExistingInstall: true,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: ['@scope/demo-plugin-dep'],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: ['DEMO_PLUGIN_KEY'],
      requiredConfigKeys: ['workspaceId'],
    });
    expect(fs.existsSync(path.join(installedDir, 'stale.txt'))).toBe(false);
    expect(runtimeConfig.read().plugins.list).toEqual([
      { id: 'demo-plugin', enabled: true, config: { workspaceId: 'a' } },
    ]);
  });

  test('reinstalls an npm-spec plugin with a single staged fetch', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const cwd = makeTempDir('hybridclaw-plugin-cwd-');
    const runtimeConfig = createRuntimeConfigState();
    const installedDir = path.join(homeDir, 'plugins', 'demo-plugin');
    writePluginDir(installedDir, { packageName: '@scope/old-demo-plugin' });
    fs.writeFileSync(
      path.join(installedDir, 'stale.txt'),
      'old build artifact\n',
      'utf-8',
    );

    const runCommand = vi.fn(
      ({
        args,
        cwd: commandCwd,
      }: {
        command: string;
        args: string[];
        cwd: string;
      }) => {
        if (
          args[0] === 'install' &&
          args.includes('--no-package-lock') &&
          args.includes('@scope/demo-plugin')
        ) {
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

    const { reinstallPlugin } = await import(
      '../src/plugins/plugin-install.js'
    );
    const result = await reinstallPlugin('@scope/demo-plugin', {
      homeDir,
      cwd,
      runCommand,
      approveDependencyInstall: true,
      getRuntimeConfig: runtimeConfig.getRuntimeConfig,
      updateRuntimeConfig: runtimeConfig.updateRuntimeConfig,
    });

    expect(result).toEqual({
      pluginId: 'demo-plugin',
      pluginDir: installedDir,
      source: '@scope/demo-plugin',
      alreadyInstalled: false,
      replacedExistingInstall: true,
      dependenciesInstalled: true,
      dependencySummary: {
        usedPackageJson: false,
        installedNodePackages: ['@scope/demo-plugin'],
        installedPipPackages: [],
      },
      configuredRequiredBins: [],
      externalDependencies: [],
      requiresEnv: ['DEMO_PLUGIN_KEY'],
      requiredConfigKeys: ['workspaceId'],
    });
    expect(fs.existsSync(path.join(installedDir, 'stale.txt'))).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
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
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '@scope/demo-plugin',
        ],
      }),
    );
  });

  test('uninstalls a home plugin and removes matching runtime config overrides', async () => {
    const homeDir = makeTempDir('hybridclaw-plugin-home-');
    const pluginDir = path.join(homeDir, 'plugins', 'demo-plugin');
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
      pluginDir: path.join(homeDir, 'plugins', 'demo-plugin'),
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
