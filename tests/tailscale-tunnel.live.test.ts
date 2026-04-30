import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test, vi } from 'vitest';

const RUN_LIVE = process.env.HYBRIDCLAW_RUN_LIVE_TAILSCALE === '1';
const SANDBOX_AUTHKEY = process.env.TS_SANDBOX_AUTHKEY || '';
const liveTest = RUN_LIVE && SANDBOX_AUTHKEY ? test : test.skip;

const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP server address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function fetchTextWithRetry(url: string): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(1_000);
  }
  throw lastError || new Error('Tailscale Funnel did not return a response.');
}

liveTest(
  'forwards public traffic through Tailscale Funnel using an encrypted sandbox authkey',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ts-live-'));
    const marker = `hybridclaw-tailscale-live-${Date.now()}`;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(marker);
    });
    let provider: { stop(): Promise<void> } | null = null;

    try {
      process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
      process.env.HOME = tmpDir;
      process.env.HYBRIDCLAW_MASTER_KEY = 'test-tailscale-live-master-key';
      vi.resetModules();

      const { saveNamedRuntimeSecrets } = await import(
        '../src/security/runtime-secrets.js'
      );
      saveNamedRuntimeSecrets({ TS_AUTHKEY: SANDBOX_AUTHKEY });

      const { TailscaleTunnelProvider } = await import(
        '../src/tunnel/tailscale-tunnel-provider.js'
      );
      const port = await listen(server);
      provider = new TailscaleTunnelProvider({
        addr: `http://127.0.0.1:${port}`,
      });

      const result = await provider.start();
      expect(result.public_url).toMatch(/^https:\/\/.+\.ts\.net$/);

      const body = await fetchTextWithRetry(result.public_url);
      expect(body).toBe(marker);
    } finally {
      if (provider) {
        await provider.stop();
      }
      await closeServer(server).catch(() => {});
      fs.rmSync(tmpDir, { recursive: true, force: true });
      restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
      restoreEnvVar('HOME', ORIGINAL_HOME);
      restoreEnvVar('HYBRIDCLAW_MASTER_KEY', ORIGINAL_MASTER_KEY);
      vi.resetModules();
    }
  },
  120_000,
);
