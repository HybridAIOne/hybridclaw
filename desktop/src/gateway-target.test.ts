import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildGatewayEnv,
  buildGatewayNodePath,
  buildGatewayPath,
  isInAppUrl,
  normalizeGatewayBaseUrl,
  routeForUrl,
  routeUrl,
} from './gateway-target.js';

describe('normalizeGatewayBaseUrl', () => {
  test('uses the default gateway when the input is empty', () => {
    expect(normalizeGatewayBaseUrl('')).toBe('http://127.0.0.1:9090');
  });

  test('strips a trailing slash', () => {
    expect(normalizeGatewayBaseUrl('http://127.0.0.1:9090/')).toBe(
      'http://127.0.0.1:9090',
    );
  });

  test('rejects URLs with extra path state', () => {
    expect(() =>
      normalizeGatewayBaseUrl('http://127.0.0.1:9090/admin'),
    ).toThrow(/must not include a path/i);
  });
});

describe('route helpers', () => {
  test('builds chat, agents, and admin URLs against the same origin', () => {
    expect(routeUrl('http://127.0.0.1:9090', 'chat')).toBe(
      'http://127.0.0.1:9090/chat',
    );
    expect(routeUrl('http://127.0.0.1:9090', 'agents')).toBe(
      'http://127.0.0.1:9090/agents',
    );
    expect(routeUrl('http://127.0.0.1:9090', 'admin')).toBe(
      'http://127.0.0.1:9090/admin',
    );
  });

  test('classifies in-app routes only for the configured gateway origin', () => {
    expect(
      routeForUrl('http://127.0.0.1:9090/chat', 'http://127.0.0.1:9090'),
    ).toBe('chat');
    expect(
      routeForUrl('http://127.0.0.1:9090/agents', 'http://127.0.0.1:9090'),
    ).toBe('agents');
    expect(
      routeForUrl(
        'http://127.0.0.1:9090/admin/scheduler',
        'http://127.0.0.1:9090',
      ),
    ).toBe('admin');
    expect(
      isInAppUrl('https://example.com/chat', 'http://127.0.0.1:9090'),
    ).toBe(false);
  });
});

describe('buildGatewayEnv', () => {
  test('maps the gateway host and port into the child runtime env', () => {
    const env = buildGatewayEnv('https://hybridclaw.local:19090', {
      runtimeRoot: '/runtime',
      nodeExecutable: '/runtime/bin/node',
    });
    expect(env.GATEWAY_BASE_URL).toBe('https://hybridclaw.local:19090');
    expect(env.HEALTH_HOST).toBe('hybridclaw.local');
    expect(env.HEALTH_PORT).toBe('19090');
  });

  test('puts the skill libraries the app packages ahead of an inherited NODE_PATH', () => {
    const desktopPackage = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, '..', 'package.json'),
        'utf8',
      ),
    ) as { build: { extraResources: Array<{ from: string; to: string }> } };
    const packaged = desktopPackage.build.extraResources.find(
      (resource) => resource.from === 'build/runtime-deps/tools-node_modules',
    );
    expect(packaged?.to.startsWith('hybridclaw-runtime/')).toBe(true);
    const runtimeRoot = path.join('/Applications', 'HybridClaw.app');
    const toolLibraries = path.join(
      runtimeRoot,
      path.relative('hybridclaw-runtime', packaged?.to ?? ''),
    );

    expect(buildGatewayNodePath(runtimeRoot, '/opt/inherited')).toBe(
      [toolLibraries, '/opt/inherited'].join(path.delimiter),
    );
    expect(buildGatewayNodePath(runtimeRoot, undefined)).toBe(toolLibraries);
  });

  test('falls back to the bundled Node for skills and host agents', () => {
    const env = buildGatewayEnv('http://127.0.0.1:9090', {
      runtimeRoot: '/runtime',
      nodeExecutable: '/runtime/bin/node',
    });
    expect(env.PATH?.split(path.delimiter).at(-1)).toBe('/runtime/bin');
  });

  test('extends a minimal GUI PATH with common Docker install locations', () => {
    const gatewayPath = buildGatewayPath('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(gatewayPath.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/Applications/Docker.app/Contents/Resources/bin',
    ]);
  });
});
