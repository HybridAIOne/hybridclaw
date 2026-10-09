import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

// An install whose package.json ships plugins/twilio-voice but whose image
// left the directory out (the v0.40 Docker image before the plugin was
// copied in). A bare id must not fall through to `npm install twilio-voice`.
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

async function installBareId(id: string) {
  packageRoot.dir = makeTempDir();
  fs.writeFileSync(
    path.join(packageRoot.dir, 'package.json'),
    JSON.stringify({
      name: '@hybridaione/hybridclaw',
      files: ['dist/', 'plugins/tier-router/', 'plugins/twilio-voice/'],
    }),
  );
  const runCommand = vi.fn();
  let config = { plugins: { list: [] } } as unknown as RuntimeConfig;
  const { installPlugin } = await import('../src/plugins/plugin-install.js');
  const result = installPlugin(id, {
    homeDir: makeTempDir(),
    cwd: makeTempDir(),
    runCommand,
    approveDependencyInstall: true,
    getRuntimeConfig: () => structuredClone(config),
    updateRuntimeConfig: (mutator: (draft: RuntimeConfig) => void) => {
      const draft = structuredClone(config);
      mutator(draft);
      config = draft;
      return structuredClone(config);
    },
  });
  return { result, runCommand };
}

test('a packaged plugin missing from the install is refused, never fetched from npm', async () => {
  const { result, runCommand } = await installBareId('twilio-voice');

  await expect(result).rejects.toThrow(/ships with HybridClaw/);
  expect(runCommand).not.toHaveBeenCalled();
});

test('an id the package does not ship still resolves as an npm spec', async () => {
  const { result, runCommand } = await installBareId('some-community-plugin');

  await expect(result).rejects.toThrow();
  expect(runCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'npm',
      args: expect.arrayContaining(['some-community-plugin']),
    }),
  );
});
