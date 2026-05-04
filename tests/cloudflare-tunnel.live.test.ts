import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test, vi } from 'vitest';

const RUN_LIVE = process.env.HYBRIDCLAW_RUN_LIVE_CLOUDFLARE === '1';
const SANDBOX_TOKEN =
  process.env.CLOUDFLARE_SANDBOX_TUNNEL_TOKEN ||
  process.env.CLOUDFLARE_TUNNEL_TOKEN ||
  '';
const PUBLIC_URL = process.env.CLOUDFLARE_SANDBOX_TUNNEL_PUBLIC_URL || '';
const ORIGIN_ADDR =
  process.env.CLOUDFLARE_SANDBOX_TUNNEL_ORIGIN_ADDR || '127.0.0.1:9090';
const liveTest = RUN_LIVE && SANDBOX_TOKEN && PUBLIC_URL ? test : test.skip;

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

async function listen(
  server: http.Server,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
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
  throw lastError || new Error('Cloudflare Tunnel did not return a response.');
}

liveTest(
  'forwards public traffic through Cloudflare Tunnel using an encrypted sandbox token',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cf-live-'));
    const marker = `hybridclaw-cloudflare-live-${Date.now()}`;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(marker);
    });
    let provider: { stop(): Promise<void> } | null = null;

    try {
      process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
      process.env.HOME = tmpDir;
      process.env.HYBRIDCLAW_MASTER_KEY = 'test-cloudflare-live-master-key';
      vi.resetModules();

      const [host, rawPort] = ORIGIN_ADDR.split(':');
      const port = Number(rawPort);
      if (!host || !Number.isInteger(port)) {
        throw new Error(
          'CLOUDFLARE_SANDBOX_TUNNEL_ORIGIN_ADDR must be host:port.',
        );
      }

      const { saveNamedRuntimeSecrets } = await import(
        '../src/security/runtime-secrets.js'
      );
      saveNamedRuntimeSecrets({ CLOUDFLARE_TUNNEL_TOKEN: SANDBOX_TOKEN });

      const { CloudflareTunnelProvider } = await import(
        '../src/tunnel/cloudflare-tunnel-provider.js'
      );
      await listen(server, host, port);
      provider = new CloudflareTunnelProvider({
        addr: ORIGIN_ADDR,
        publicUrl: PUBLIC_URL,
      });

      const result = await provider.start();
      expect(result.public_url).toMatch(/^https?:\/\//);

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
