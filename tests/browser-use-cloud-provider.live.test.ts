import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const RUN_LIVE = process.env.HYBRIDCLAW_RUN_LIVE_BROWSER_USE_CLOUD === '1';
const BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY || '';
const liveTest = RUN_LIVE && BROWSER_USE_API_KEY ? test : test.skip;

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

liveTest(
  'starts a Browser Use Cloud session, navigates through CDP, meters usage, and stops the session',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-bu-cloud-live-'));
    let cleanupSession: (() => Promise<void>) | null = null;
    try {
      process.env.HOME = tmpDir;
      process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
      process.env.HYBRIDCLAW_MASTER_KEY = 'browser-use-cloud-live-test-key';
      vi.resetModules();

      const { initDatabase, getSessionUsageTotals } = await import(
        '../src/memory/db.js'
      );
      const { BrowserUseCloudProvider } = await import(
        '../src/browser/browser-use-cloud-provider.js'
      );
      initDatabase({ quiet: true, dbPath: path.join(tmpDir, 'usage.db') });

      const provider = new BrowserUseCloudProvider({
        apiKeyRef: { source: 'env', id: 'BROWSER_USE_API_KEY' },
        browser: {
          timeoutMinutes: 1,
          proxyCountryCode: null,
          enableRecording: false,
        },
      });
      const session = await provider.launchSession({
        metering: {
          sessionId: 'browser-use-cloud-live',
          agentId: 'browser-use-cloud-live-agent',
        },
      });
      cleanupSession = async () => {
        await provider.closeSession(session);
      };
      await session.navigate('https://example.com/', {
        waitUntil: 'domcontentloaded',
        timeoutMs: 30_000,
      });
      const title = await session.evaluate(() => document.title);
      const screenshot = await session.screenshot();
      await cleanupSession();
      cleanupSession = null;

      expect(title).toMatch(/Example Domain/u);
      expect(screenshot.length).toBeGreaterThan(0);
      expect(
        getSessionUsageTotals('browser-use-cloud-live').total_cost_usd,
      ).toBeGreaterThan(0);
    } finally {
      if (cleanupSession) {
        await cleanupSession().catch(() => {});
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      restoreEnvVar('HOME', ORIGINAL_HOME);
      restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
      restoreEnvVar('HYBRIDCLAW_MASTER_KEY', ORIGINAL_MASTER_KEY);
      vi.resetModules();
    }
  },
  120_000,
);
