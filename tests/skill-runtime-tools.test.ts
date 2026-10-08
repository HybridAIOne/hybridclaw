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
  unmock: ['node:child_process'],
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
});
