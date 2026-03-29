import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-host-runtime-setup-'),
  );
  tempDirs.push(dir);
  return dir;
}

function writeContainerPackage(
  installRoot: string,
  dependencies: Record<string, string>,
): void {
  fs.mkdirSync(path.join(installRoot, 'container'), { recursive: true });
  fs.writeFileSync(
    path.join(installRoot, 'container', 'package.json'),
    JSON.stringify({
      name: '@hybridaione/hybridclaw-container',
      version: '0.9.5',
      dependencies,
    }),
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureHostRuntimeReady', () => {
  test('throws a reinstall error when packaged runtime dependencies are missing', async () => {
    const installRoot = createTempDir();
    fs.writeFileSync(
      path.join(installRoot, 'package.json'),
      '{"name":"@hybridaione/hybridclaw"}',
    );
    fs.mkdirSync(path.join(installRoot, 'container', 'dist'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(installRoot, 'container', 'dist', 'index.js'),
      '',
    );
    writeContainerPackage(installRoot, {
      '@modelcontextprotocol/sdk': '^1.27.1',
    });

    const { ensureHostRuntimeReady } = await import(
      '../src/infra/host-runtime-setup.ts'
    );

    expect(() =>
      ensureHostRuntimeReady({
        commandName: 'hybridclaw tui',
        installRoot,
      }),
    ).toThrow(
      'hybridclaw tui: Host runtime is not ready. Missing runtime dependency: @modelcontextprotocol/sdk. Reinstall HybridClaw.',
    );
  });

  test('uses the source-checkout hint when dependencies are missing in a repo checkout', async () => {
    const installRoot = createTempDir();
    fs.writeFileSync(
      path.join(installRoot, 'package.json'),
      '{"name":"@hybridaione/hybridclaw"}',
    );
    fs.writeFileSync(
      path.join(installRoot, '.git'),
      'gitdir: ./.git/worktrees/dev\n',
    );
    fs.mkdirSync(path.join(installRoot, 'container', 'dist'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(installRoot, 'container', 'dist', 'index.js'),
      '',
    );
    writeContainerPackage(installRoot, {
      '@modelcontextprotocol/sdk': '^1.27.1',
    });

    const { ensureHostRuntimeReady } = await import(
      '../src/infra/host-runtime-setup.ts'
    );

    expect(() =>
      ensureHostRuntimeReady({
        commandName: 'hybridclaw tui',
        installRoot,
      }),
    ).toThrow(
      'If you are running from a source checkout, run `npm run setup` first.',
    );
  });

  test('accepts installed container dependencies even when the package root is not resolvable', async () => {
    const installRoot = createTempDir();
    fs.writeFileSync(
      path.join(installRoot, 'package.json'),
      '{"name":"@hybridaione/hybridclaw"}',
    );
    fs.mkdirSync(path.join(installRoot, 'container', 'dist'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(installRoot, 'container', 'dist', 'index.js'),
      '',
    );
    writeContainerPackage(installRoot, {
      '@modelcontextprotocol/sdk': '^1.27.1',
    });
    fs.mkdirSync(
      path.join(
        installRoot,
        'container',
        'node_modules',
        '@modelcontextprotocol',
        'sdk',
      ),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(
        installRoot,
        'container',
        'node_modules',
        '@modelcontextprotocol',
        'sdk',
        'package.json',
      ),
      JSON.stringify({
        name: '@modelcontextprotocol/sdk',
        version: '1.27.1',
        exports: {
          '.': {
            require: './dist/cjs/index.js',
          },
        },
      }),
    );

    const { ensureHostRuntimeReady } = await import(
      '../src/infra/host-runtime-setup.ts'
    );

    expect(
      ensureHostRuntimeReady({
        commandName: 'hybridclaw tui',
        installRoot,
      }),
    ).toEqual({
      command: process.execPath,
      args: [path.join(installRoot, 'container', 'dist', 'index.js')],
    });
  });
});
