import { describe, expect, test } from 'vitest';
import {
  resolveGatewayEntry,
  resolveGatewayNodeExecutable,
  resolveRuntimeRoot,
} from './runtime-paths.js';

describe('resolveRuntimeRoot', () => {
  test('uses the bundled runtime inside packaged apps', () => {
    expect(
      resolveRuntimeRoot({
        currentFile: '/Applications/HybridClaw.app/Contents/Resources/app.asar/dist/main.js',
        packaged: true,
        resourcesPath: '/Applications/HybridClaw.app/Contents/Resources',
      }),
    ).toBe('/Applications/HybridClaw.app/Contents/Resources/hybridclaw-runtime');
  });

  test('uses the repo root in development', () => {
    expect(
      resolveRuntimeRoot({
        currentFile: '/Users/example/src/hybridclaw/desktop/dist/main.js',
        packaged: false,
        resourcesPath: '/unused',
      }),
    ).toBe('/Users/example/src/hybridclaw');
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
        runtimeRoot: '/Applications/HybridClaw.app/Contents/Resources/hybridclaw-runtime',
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
