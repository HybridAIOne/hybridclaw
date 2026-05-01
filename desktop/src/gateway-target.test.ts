import { describe, expect, test } from 'vitest';
import {
  buildGatewayPath,
  buildGatewayEnv,
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
    expect(() => normalizeGatewayBaseUrl('http://127.0.0.1:9090/admin')).toThrow(
      /must not include a path/i,
    );
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
    expect(routeForUrl('http://127.0.0.1:9090/chat', 'http://127.0.0.1:9090')).toBe(
      'chat',
    );
    expect(
      routeForUrl('http://127.0.0.1:9090/agents', 'http://127.0.0.1:9090'),
    ).toBe('agents');
    expect(
      routeForUrl(
        'http://127.0.0.1:9090/admin/scheduler',
        'http://127.0.0.1:9090',
      ),
    ).toBe('admin');
    expect(isInAppUrl('https://example.com/chat', 'http://127.0.0.1:9090')).toBe(
      false,
    );
  });
});

describe('buildGatewayEnv', () => {
  test('maps the gateway host and port into the child runtime env', () => {
    const env = buildGatewayEnv('https://hybridclaw.local:19090');
    expect(env.GATEWAY_BASE_URL).toBe('https://hybridclaw.local:19090');
    expect(env.HEALTH_HOST).toBe('hybridclaw.local');
    expect(env.HEALTH_PORT).toBe('19090');
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
