/**
 * Unit test for resolveMcpOAuthRedirectUri's base-URL precedence.
 *
 * In particular: an explicitly-configured public base URL
 * (GATEWAY_PUBLIC_BASE_URL) must be preferred over a request-derived origin.
 * This matters behind an ingress proxy, where the request origin can be the
 * gateway's unreachable internal address (e.g. http://172.19.0.22:9090) and the
 * OAuth redirect would otherwise be undeliverable to the user's browser.
 *
 * GATEWAY_PUBLIC_BASE_URL is applied from the environment when config.ts loads,
 * so each case sets the env and re-imports the module under a fresh registry.
 * Uses a temp HYBRIDCLAW_DATA_DIR and the file-watcher-disabled flag, matching
 * config-reload.integration.test.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

let tmpDir: string;
let originalDataDir: string | undefined;
let originalHome: string | undefined;
let originalWatcher: string | undefined;
let originalPublicBaseUrl: string | undefined;

type GatewayServiceModule = typeof import('../src/gateway/gateway-service.js');

// Sets GATEWAY_PUBLIC_BASE_URL (or clears it) and re-imports gateway-service so
// config.ts re-applies it at module load.
async function loadGateway(
  publicBaseUrl: string | undefined,
): Promise<GatewayServiceModule> {
  if (publicBaseUrl === undefined) delete process.env.GATEWAY_PUBLIC_BASE_URL;
  else process.env.GATEWAY_PUBLIC_BASE_URL = publicBaseUrl;
  vi.resetModules();
  return await import('../src/gateway/gateway-service.js');
}

beforeAll(() => {
  originalDataDir = process.env.HYBRIDCLAW_DATA_DIR;
  originalHome = process.env.HOME;
  originalWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  originalPublicBaseUrl = process.env.GATEWAY_PUBLIC_BASE_URL;
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-oauth-redirect-'));
  process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
  process.env.HOME = tmpDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.GATEWAY_PUBLIC_BASE_URL;
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

afterAll(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('HYBRIDCLAW_DATA_DIR', originalDataDir);
  restore('HOME', originalHome);
  restore('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', originalWatcher);
  restore('GATEWAY_PUBLIC_BASE_URL', originalPublicBaseUrl);
});

describe('resolveMcpOAuthRedirectUri', () => {
  it('uses the request origin when no public base URL is configured', async () => {
    const gw = await loadGateway(undefined);
    expect(
      gw.resolveMcpOAuthRedirectUri('https://u-abc.sbx.example.com'),
    ).toBe('https://u-abc.sbx.example.com/api/mcp/oauth/callback');
  });

  it('prefers the configured public base URL over the request origin', async () => {
    const gw = await loadGateway('https://u-abc.sbx.example.com');
    // The request origin here is the unreachable internal gateway address.
    expect(
      gw.resolveMcpOAuthRedirectUri('http://172.19.0.22:9090'),
    ).toBe('https://u-abc.sbx.example.com/api/mcp/oauth/callback');
  });

  it('strips a trailing slash from the configured public base URL', async () => {
    const gw = await loadGateway('https://u-abc.sbx.example.com/');
    expect(
      gw.resolveMcpOAuthRedirectUri('http://172.19.0.22:9090'),
    ).toBe('https://u-abc.sbx.example.com/api/mcp/oauth/callback');
  });
});
