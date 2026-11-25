import fs from 'node:fs';
import path from 'node:path';

import { expect, it, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

// Bare plugin ids must never fall through to the public npm registry:
// bundled plugins missing from a trimmed install, externally hosted channel
// plugins (like WhatsApp), and unknown/typo bare ids must fail fast without
// contacting npm. Only an explicit `npm:<pkg>` (or scoped `@scope/<pkg>`)
// reaches npm, and only after explicit approval.
const packageRoot = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/infra/install-root.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/infra/install-root.js')>();
  return {
    ...actual,
    resolveInstallRoot: () => packageRoot.dir,
    resolveInstallPath: (...segments: string[]) =>
      path.join(packageRoot.dir, ...segments),
  };
});

const makeTempDir = useTempDir('hybridclaw-packaged-ids-');
useCleanMocks({ resetModules: true });

function writeSimplePlugin(dir: string, id: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hybridclaw.plugin.yaml'),
    `id: ${id}\nname: ${id}\nversion: 1.0.0\nentrypoint: index.js\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export default { id: '${id}', register() {} };\n`,
    'utf-8',
  );
}

async function runInstallFixture(params: {
  source: string;
  verb?: 'install' | 'reinstall';
  bundledPresent?: string[];
  cwdPlugins?: string[];
  approveNpmInstall?: boolean;
  mockNpmFetchPluginId?: string;
}) {
  packageRoot.dir = makeTempDir();
  const cwd = makeTempDir();
  const homeDir = makeTempDir();
  fs.writeFileSync(
    path.join(packageRoot.dir, 'package.json'),
    JSON.stringify({
      name: '@hybridaione/hybridclaw',
      files: ['dist/', 'plugins/tier-router/', 'plugins/twilio-voice/'],
    }),
  );
  for (const id of params.bundledPresent ?? []) {
    writeSimplePlugin(path.join(packageRoot.dir, 'plugins', id), id);
  }
  for (const id of params.cwdPlugins ?? []) {
    writeSimplePlugin(path.join(cwd, 'plugins', id), id);
  }

  const runCommand = vi.fn(
    ({
      args,
      cwd: commandCwd,
    }: {
      command: string;
      args: string[];
      cwd: string;
    }) => {
      if (params.mockNpmFetchPluginId && args[0] === 'install') {
        const fetchedDir = path.join(
          commandCwd,
          'node_modules',
          params.mockNpmFetchPluginId,
        );
        writeSimplePlugin(fetchedDir, params.mockNpmFetchPluginId);
      }
    },
  );
  let config = { plugins: { list: [] } } as unknown as RuntimeConfig;
  const { installPlugin, reinstallPlugin } = await import(
    '../src/plugins/plugin-install.js'
  );
  const runner = params.verb === 'reinstall' ? reinstallPlugin : installPlugin;
  const promise = runner(params.source, {
    homeDir,
    cwd,
    runCommand,
    approveNpmInstall: params.approveNpmInstall,
    approveDependencyInstall: true,
    getRuntimeConfig: () => structuredClone(config),
    updateRuntimeConfig: (mutator: (draft: RuntimeConfig) => void) => {
      const draft = structuredClone(config);
      mutator(draft);
      config = draft;
      return structuredClone(config);
    },
  });
  return { promise, runCommand, homeDir, cwd, packageDir: packageRoot.dir };
}

it.each([
  {
    name: 'bundled id present enables the bundled copy without touching npm',
    source: 'tier-router',
    bundledPresent: ['tier-router'],
    cwdPlugins: [],
    approveNpmInstall: false,
    expectOk: true,
    expectedPluginId: 'tier-router',
    expectNpmSpec: null,
  },
  {
    name: 'bundled id missing (trimmed-image case) fails without touching npm',
    source: 'twilio-voice',
    bundledPresent: [],
    cwdPlugins: [],
    approveNpmInstall: true,
    expectOk: false,
    expectedError: /ships with HybridClaw.*never fetched from npm/i,
    expectNpmSpec: null,
  },
  {
    name: 'externally hosted channel catalog id (whatsapp) fails without touching npm',
    source: 'whatsapp',
    bundledPresent: [],
    cwdPlugins: [],
    approveNpmInstall: true,
    expectOk: false,
    expectedError:
      /externally hosted HybridClaw channel plugin.*plugin enable whatsapp/i,
    expectNpmSpec: null,
  },
  {
    name: 'cwd plugin installs locally without touching npm',
    source: 'local-helper',
    bundledPresent: [],
    cwdPlugins: ['local-helper'],
    approveNpmInstall: false,
    expectOk: true,
    expectedPluginId: 'local-helper',
    expectNpmSpec: null,
  },
  {
    name: 'unknown bare id without explicit npm: form is refused without touching npm',
    source: 'some-community-plugin',
    bundledPresent: [],
    cwdPlugins: [],
    approveNpmInstall: true,
    expectOk: false,
    expectedError:
      /Bare plugin ids are not fetched from npm automatically.*npm:some-community-plugin/,
    expectNpmSpec: null,
  },
  {
    name: 'explicit npm: form without approval requires confirmation and does not touch npm',
    source: 'npm:some-community-plugin',
    bundledPresent: [],
    cwdPlugins: [],
    approveNpmInstall: false,
    expectOk: false,
    expectedError: /requires explicit approval/i,
    expectNpmSpec: null,
  },
  {
    name: 'explicit npm: form with approval strips the prefix and fetches from npm',
    source: 'npm:some-community-plugin',
    bundledPresent: [],
    cwdPlugins: [],
    approveNpmInstall: true,
    mockNpmFetchPluginId: 'some-community-plugin',
    expectOk: true,
    expectedPluginId: 'some-community-plugin',
    expectNpmSpec: 'some-community-plugin',
  },
] as const)('$name', async (scenario) => {
  for (const verb of ['install', 'reinstall'] as const) {
    const { promise, runCommand } = await runInstallFixture({
      source: scenario.source,
      verb,
      bundledPresent: [...scenario.bundledPresent],
      cwdPlugins: [...scenario.cwdPlugins],
      approveNpmInstall: scenario.approveNpmInstall,
      mockNpmFetchPluginId:
        'mockNpmFetchPluginId' in scenario
          ? scenario.mockNpmFetchPluginId
          : undefined,
    });

    if (scenario.expectOk) {
      const result = await promise;
      expect(result.pluginId).toBe(scenario.expectedPluginId);
    } else {
      await expect(promise).rejects.toThrow(scenario.expectedError);
    }

    if (scenario.expectNpmSpec) {
      expect(runCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'npm',
          args: expect.arrayContaining([scenario.expectNpmSpec]),
        }),
      );
      expect(
        runCommand.mock.calls.every(
          ([call]) => !(call as { args: string[] }).args.includes(scenario.source),
        ),
      ).toBe(true);
    } else {
      expect(runCommand).not.toHaveBeenCalled();
    }
  }
});

test.each([
  ['npm:', /Missing npm package spec/],
  ['npm:   ', /Missing npm package spec/],
  ['npm:--registry=https://evil.example', /Invalid npm package spec/],
  ['npm:../escape', /Invalid npm package spec/],
  ['npm:https://evil.example/pkg.tgz', /Invalid npm package spec/],
  ['npm:foo bar', /Invalid npm package spec/],
] as const)(
  'rejects malformed explicit npm source %s without touching npm',
  async (source, expectedError) => {
    const { promise, runCommand } = await runInstallFixture({
      source,
      approveNpmInstall: true,
    });

    await expect(promise).rejects.toThrow(expectedError);
    expect(runCommand).not.toHaveBeenCalled();
  },
);

test('remote archive URLs (such as the official WhatsApp release tarball) still fetch without requiring npm:', async () => {
  const url =
    'https://github.com/HybridAIOne/hybridclaw-whatsapp/releases/download/v0.2.0/hybridaione-hybridclaw-whatsapp-0.2.0.tgz';
  const { promise, runCommand } = await runInstallFixture({
    source: url,
    approveNpmInstall: false,
    mockNpmFetchPluginId: 'whatsapp',
  });

  const result = await promise;
  expect(result.pluginId).toBe('whatsapp');
  expect(runCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'npm',
      args: expect.arrayContaining([url]),
    }),
  );
});

test('CLI plugin install npm:<pkg> requires interactive confirmation or --yes', async () => {
  packageRoot.dir = makeTempDir();
  fs.writeFileSync(
    path.join(packageRoot.dir, 'package.json'),
    JSON.stringify({
      name: '@hybridaione/hybridclaw',
      files: ['dist/', 'plugins/tier-router/'],
    }),
  );
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
  });
  try {
    const { handlePluginCommand } = await import(
      '../src/cli/plugin-command.js'
    );
    await expect(
      handlePluginCommand(['install', 'npm:some-community-plugin']),
    ).rejects.toThrow(
      /Installing plugin "some-community-plugin" from the npm registry requires an interactive terminal\. Re-run with --yes to approve\./,
    );
  } finally {
    if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
    if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
  }
});
