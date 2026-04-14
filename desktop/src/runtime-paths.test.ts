import { describe, expect, test } from 'vitest';
import { resolveGatewayEntry, resolveRuntimeRoot } from './runtime-paths.js';

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
