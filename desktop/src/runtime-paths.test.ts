import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  resolveGatewayEntry,
  resolveGatewayNodeExecutable,
  resolveRuntimeRoot,
} from './runtime-paths.js';

describe('resolveRuntimeRoot', () => {
  test('uses the bundled runtime inside packaged apps', () => {
    expect(
      resolveRuntimeRoot({
        currentFile:
          '/Applications/HybridClaw.app/Contents/Resources/app.asar/dist/main.js',
        packaged: true,
        resourcesPath: '/Applications/HybridClaw.app/Contents/Resources',
      }),
    ).toBe(
      '/Applications/HybridClaw.app/Contents/Resources/hybridclaw-runtime',
    );
  });

  describe('in development', () => {
    let fakeRepoRoot: string;

    beforeAll(() => {
      fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-runtime-root-'));
      fs.writeFileSync(path.join(fakeRepoRoot, 'package.json'), '{}');
      fs.mkdirSync(path.join(fakeRepoRoot, 'desktop', 'dist'), {
        recursive: true,
      });
    });

    afterAll(() => {
      fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
    });

    test('uses the repo root when package.json is present', () => {
      expect(
        resolveRuntimeRoot({
          currentFile: path.join(fakeRepoRoot, 'desktop', 'dist', 'main.js'),
          packaged: false,
          resourcesPath: '/unused',
        }),
      ).toBe(fakeRepoRoot);
    });

    test('throws when the resolved root is missing package.json', () => {
      expect(() =>
        resolveRuntimeRoot({
          currentFile: '/Users/example/src/hybridclaw/desktop/dist/main.js',
          packaged: false,
          resourcesPath: '/unused',
        }),
      ).toThrow(/no package\.json was found/);
    });
  });
});

describe('resolveGatewayEntry', () => {
  test('points at the compiled cli entrypoint', () => {
    expect(resolveGatewayEntry('/Users/example/src/hybridclaw')).toBe(
      '/Users/example/src/hybridclaw/dist/cli.js',
    );
  });
});

describe('resolveGatewayNodeExecutable', () => {
  test('uses the bundled node binary inside packaged apps', () => {
    expect(
      resolveGatewayNodeExecutable({
        env: {},
        packaged: true,
        processExecPath:
          '/Applications/HybridClaw.app/Contents/MacOS/HybridClaw',
        runtimeRoot:
          '/Applications/HybridClaw.app/Contents/Resources/hybridclaw-runtime',
      }),
    ).toBe(
      '/Applications/HybridClaw.app/Contents/Resources/hybridclaw-runtime/bin/node',
    );
  });

  test('prefers the injected node executable in development', () => {
    expect(
      resolveGatewayNodeExecutable({
        env: {
          HYBRIDCLAW_DESKTOP_NODE_EXECUTABLE:
            '/Users/example/.nvm/versions/node/v22.15.1/bin/node',
          npm_node_execpath: '/usr/local/bin/node',
        },
        packaged: false,
        processExecPath:
          '/Users/example/src/hybridclaw/desktop/.electron-dev/HybridClaw.app/Contents/MacOS/Electron',
        runtimeRoot: '/Users/example/src/hybridclaw',
      }),
    ).toBe('/Users/example/.nvm/versions/node/v22.15.1/bin/node');
  });

  test('falls back to npm node execpath in development', () => {
    expect(
      resolveGatewayNodeExecutable({
        env: {
          npm_node_execpath: '/opt/homebrew/bin/node',
        },
        packaged: false,
        processExecPath:
          '/Users/example/src/hybridclaw/desktop/.electron-dev/HybridClaw.app/Contents/MacOS/Electron',
        runtimeRoot: '/Users/example/src/hybridclaw',
      }),
    ).toBe('/opt/homebrew/bin/node');
  });
});
