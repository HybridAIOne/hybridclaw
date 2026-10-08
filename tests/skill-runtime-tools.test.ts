import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const makeTempDir = useTempDir('hybridclaw-runtime-tools-');
useCleanMocks({
  unstubAllEnvs: true,
  resetModules: true,
  unmock: ['node:child_process', '../src/infra/install-root.ts'],
});

let dataDir = '';

beforeEach(() => {
  dataDir = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', dataDir);
  vi.resetModules();
});

function exitedProcess(): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

function writeFakePackage(nodeModulesDir: string, name: string): void {
  const dir = path.join(nodeModulesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
}

/** An install root that ships `entries` of container/tools and the real skills. */
function fakeInstallRoot(entries: string[]): string {
  const root = makeTempDir();
  fs.symlinkSync(path.join(repoRoot, 'skills'), path.join(root, 'skills'));
  const tools = path.join(root, 'container', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'container', 'package.json'),
    path.join(root, 'container', 'package.json'),
  );
  for (const entry of entries) {
    fs.cpSync(
      path.join(repoRoot, 'container', 'tools', entry),
      path.join(tools, entry),
      { recursive: true },
    );
  }
  return root;
}

async function importInstallerAt(root: string) {
  const spawnMock = vi.fn(() => exitedProcess());
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: spawnMock,
  }));
  vi.doMock('../src/infra/install-root.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/infra/install-root.ts')>()),
    resolveInstallRoot: () => root,
    resolveInstallPath: (...segments: string[]) =>
      path.join(root, ...segments),
  }));
  const { setupSkillDependencies } = await import(
    '../src/skills/skills-install.ts'
  );
  return { setupSkillDependencies, spawnMock };
}

describe('skill libraries for host-sandbox agents', () => {
  test.each([
    'xlsx',
    'docx',
    'pptx',
  ])('skill setup %s installs the locked runtime tools manifest into the data dir', async (skillName) => {
    const spawnMock = vi.fn(() => exitedProcess());
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      spawn: spawnMock,
    }));
    const { setupSkillDependencies } = await import(
      '../src/skills/skills-install.ts'
    );

    const result = await setupSkillDependencies({ skillName });

    expect(result.ok, result.message).toBe(true);
    const target = path.join(dataDir, 'runtime-tools');
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--fund=false',
        '--prefix',
        target,
      ],
      expect.anything(),
    );
    for (const file of [
      'package.json',
      'package-lock.json',
      path.join('stubs', 'image-size', 'package.json'),
    ]) {
      expect(fs.readFileSync(path.join(target, file), 'utf8')).toBe(
        fs.readFileSync(path.join(repoRoot, 'container', 'tools', file), 'utf8'),
      );
    }
  });

  test('host agents resolve libraries that setup installed into the data dir', async () => {
    const { hasAgentNodeModule } = await import(
      '../src/skills/skill-node-modules.ts'
    );
    expect(hasAgentNodeModule('hybridclaw-fake-tool', 'host')).toBe(false);

    writeFakePackage(
      path.join(dataDir, 'runtime-tools', 'node_modules'),
      'hybridclaw-fake-tool',
    );

    expect(hasAgentNodeModule('hybridclaw-fake-tool', 'host')).toBe(true);
    expect(hasAgentNodeModule('hybridclaw-fake-tool', 'container')).toBe(
      false,
    );
  });

  test('host agents see the agent runtime and tools libraries ahead of an inherited NODE_PATH', async () => {
    const { hostAgentNodePath } = await import(
      '../src/skills/skill-node-modules.ts'
    );
    const { resolveInstallPath } = await import('../src/infra/install-root.ts');

    expect(hostAgentNodePath('/opt/inherited').split(path.delimiter)).toEqual([
      resolveInstallPath('container', 'node_modules'),
      path.join(dataDir, 'runtime-tools', 'node_modules'),
      '/opt/inherited',
    ]);
    expect(hostAgentNodePath().split(path.delimiter)).toHaveLength(2);
  });
  test.each([
    ['package-lock.json', ['package.json', 'stubs']],
    ['stubs', ['package.json', 'package-lock.json']],
  ])('skill setup reports an installation without container/tools/%s instead of throwing', async (missing, shipped) => {
    const { setupSkillDependencies, spawnMock } = await importInstallerAt(
      fakeInstallRoot(shipped),
    );

    const result = await setupSkillDependencies({ skillName: 'xlsx' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`container/tools/${missing}`);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataDir, 'runtime-tools'))).toBe(false);
  });

  test('skill setup installs nothing when the libraries already resolve, as on the gateway image NODE_PATH', async () => {
    const root = fakeInstallRoot(['package.json', 'package-lock.json', 'stubs']);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(root, 'container', 'tools', 'package.json'),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };
    for (const name of Object.keys(manifest.dependencies)) {
      writeFakePackage(path.join(root, 'node_modules'), name);
    }
    const { setupSkillDependencies, spawnMock } =
      await importInstallerAt(root);

    const result = await setupSkillDependencies({ skillName: 'pptx' });

    expect(result.ok, result.message).toBe(true);
    expect(result.stdout).toContain('already resolve');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataDir, 'runtime-tools'))).toBe(false);
  });

  test.each([
    ['matches', true],
    ['differs from', false],
  ])('host agents use the data-dir libraries only while their lockfile %s the packaged one', async (_label, current) => {
    const target = path.join(dataDir, 'runtime-tools');
    writeFakePackage(path.join(target, 'node_modules'), 'hybridclaw-fake-tool');
    const packagedLock = fs.readFileSync(
      path.join(repoRoot, 'container', 'tools', 'package-lock.json'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(target, 'package-lock.json'),
      current ? packagedLock : packagedLock.replace('"lockfileVersion"', '"x"'),
    );
    const { hasAgentNodeModule, hostAgentNodePath } = await import(
      '../src/skills/skill-node-modules.ts'
    );

    expect(hasAgentNodeModule('hybridclaw-fake-tool', 'host')).toBe(current);
    expect(
      hostAgentNodePath().split(path.delimiter).includes(
        path.join(target, 'node_modules'),
      ),
    ).toBe(current);
  });
});
