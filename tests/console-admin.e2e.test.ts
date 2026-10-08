import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LATEST_RELEASE_NOTES } from '../console/src/release-notes.js';
import { CHANNEL_KINDS } from '../src/channels/channel.js';
import { brokenNodePty } from './helpers/broken-node-pty.js';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';
import { cleanupTrackedTempDirs } from './test-utils.js';

// Browser e2e: the built admin console (console/dist) served by the compiled
// gateway (dist/cli.js) in host-sandbox mode with an isolated data dir and
// HOME. Gated behind HYBRIDCLAW_RUN_CONSOLE_E2E=1; needs `npm run build` and a
// Playwright Chromium (`npx playwright install chromium`).
const RUN = process.env.HYBRIDCLAW_RUN_CONSOLE_E2E === '1';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'dist', 'cli.js');
const WEB_API_TOKEN = 'e2e-console-token';
const STARTUP_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;

const EXTERNAL_CHANNEL_COUNT = CHANNEL_KINDS.filter(
  (kind) => kind !== 'heartbeat' && kind !== 'scheduler' && kind !== 'tui',
).length;

const tempDirs: string[] = [];
let gateway: ChildProcess | null = null;
let gatewayLog = '';
let baseUrl = '';
let browser: Browser;
let page: Page;
const cspViolations: string[] = [];

async function startGateway(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-console-e2e-'));
  tempDirs.push(root);
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      ops: { healthPort: port },
      // Unroutable so the gateway never calls the hosted HybridAI API.
      hybridai: { baseUrl: 'http://127.0.0.1:9' },
    }),
  );
  // CI never builds node-pty; break it locally too so the terminal page
  // renders the same load failure everywhere.
  const broken = brokenNodePty(root);
  gateway = spawn(
    process.execPath,
    [
      ...broken.nodeArgs,
      CLI,
      'gateway',
      'start',
      '--foreground',
      '--sandbox=host',
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        HYBRIDCLAW_DATA_DIR: dataDir,
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
        HYBRIDAI_API_KEY: 'hai-e2e-placeholder',
        WEB_API_TOKEN,
        ...broken.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  gateway.stdout?.on('data', (chunk) => {
    gatewayLog += chunk;
  });
  gateway.stderr?.on('data', (chunk) => {
    gatewayLog += chunk;
  });
  await waitForHealth(`${baseUrl}/health`, STARTUP_TIMEOUT_MS);
}

async function stopGateway(): Promise<void> {
  const child = gateway;
  gateway = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

async function api<T>(
  pathname: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${WEB_API_TOKEN}`,
      ...(init.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    throw new Error(`${pathname}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function open(pathname: string): Promise<void> {
  await page.goto(`${baseUrl}${pathname}`);
  await page.locator('.main-panel').waitFor();
}

function channelCard(label: string) {
  return page
    .locator('.channel-selectable-row')
    .filter({ has: page.getByText(label, { exact: true }) });
}

function channelSettingsHeading(label: string) {
  return page.getByText(`${label} settings`, { exact: true });
}

describe.skipIf(!RUN)('admin console against a live gateway', () => {
  beforeAll(async () => {
    expect(fs.existsSync(CLI), 'run `npm run build` first').toBe(true);
    expect(
      fs.existsSync(path.join(REPO, 'console', 'dist', 'index.html')),
      'run `npm run build` first',
    ).toBe(true);
    try {
      await startGateway();
    } catch (error) {
      console.error('--- gateway log ---\n', gatewayLog);
      throw error;
    }
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    // Pre-dismiss the What's New dialog; it would cover the first page a test opens.
    await context.addInitScript((version) => {
      window.localStorage.setItem('hybridclaw_whats_new_seen_version', version);
    }, LATEST_RELEASE_NOTES.version);
    // The gateway trusts loopback browsers, so the console skips its token prompt.
    page = await context.newPage();
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        message.text().includes('Content Security Policy')
      ) {
        cspViolations.push(message.text().slice(0, 200));
      }
    });
  }, STARTUP_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    await browser?.close();
    await stopGateway();
    cleanupTrackedTempDirs(tempDirs);
  }, STOP_TIMEOUT_MS + 10_000);

  test.each(['/admin', '/admin/channels', '/admin/config', '/admin/logs'])(
    '%s loads without Content Security Policy violations',
    async (pathname) => {
      cspViolations.length = 0;
      await open(pathname);
      await page.evaluate(() => document.fonts.ready);
      expect(cspViolations).toEqual([]);
    },
  );

  test('the terminal page shows the node-pty rebuild hint when the addon cannot load', async () => {
    await open('/admin/terminal');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const banner = page.locator('.terminal-error-banner');
    await banner.waitFor();
    await expect(banner.textContent()).resolves.toContain(
      'npm rebuild node-pty',
    );
  });

  describe('channels', () => {
    test('lists one labelled card with a logo per external channel kind', async () => {
      await open('/admin/channels');
      const cards = page.locator('.channel-selectable-row');
      await expect.poll(() => cards.count()).toBe(EXTERNAL_CHANNEL_COUNT);
      await expect(cards.locator('.channel-logo svg').count()).resolves.toBe(
        EXTERNAL_CHANNEL_COUNT,
      );
      for (const label of [
        'Discord',
        'Discord Incoming Webhook',
        'Microsoft Teams',
        'Slack Incoming Webhook',
        'iMessage',
      ]) {
        await expect(channelCard(label).count()).resolves.toBe(1);
      }
    });

    test('orders cards by status, then label, and flags uninstalled channel plugins', async () => {
      await open('/admin/channels');
      const cards = page.locator('.channel-selectable-row');
      await expect.poll(() => cards.count()).toBe(EXTERNAL_CHANNEL_COUNT);
      // A fresh gateway has every channel at the same "available" status.
      const labels = await cards.locator('strong').allTextContents();
      expect(labels).toEqual(
        [...labels].sort((left, right) => left.localeCompare(right)),
      );
      for (const label of ['LINE', 'WhatsApp']) {
        await expect(channelCard(label).textContent()).resolves.toContain(
          'plugin not installed',
        );
      }
    });

    test.each([
      ['Microsoft Teams', 'teams'],
      ['Slack Incoming Webhook', 'slack_webhook'],
    ])('%s settings panel is addressable as #%s', async (label, fragment) => {
      await open('/admin/channels');
      await channelCard(label).click();
      await page
        .locator(`[id="${fragment}"]`)
        .getByText(`${label} settings`, { exact: true })
        .waitFor();

      await open('/admin');
      await open(`/admin/channels#${fragment}`);
      await channelSettingsHeading(label).waitFor();
    });
  });

  describe('settings', () => {
    test.each([
      ['discord', 'discord', 'Discord'],
      ['discordWebhook', 'discord_webhook', 'Discord Incoming Webhook'],
      ['email', 'email', 'Email'],
      ['imessage', 'imessage', 'iMessage'],
      ['line', 'line', 'LINE'],
      ['msteams', 'teams', 'Microsoft Teams'],
      ['signal', 'signal', 'Signal'],
      ['slack', 'slack', 'Slack'],
      ['slackWebhook', 'slack_webhook', 'Slack Incoming Webhook'],
      ['telegram', 'telegram', 'Telegram'],
      ['threema', 'threema', 'Threema'],
      ['voice', 'voice', 'Voice'],
      ['whatsapp', 'whatsapp', 'WhatsApp'],
    ])(
      'the %s section hands off to the Channels card #%s',
      async (section, fragment, label) => {
        await open(`/admin/config?section=${section}`);
        const link = page
          .locator(`[id="settings-section-${section}"]`)
          .getByRole('link', { name: 'Open Channels →' });
        await expect(link.getAttribute('href')).resolves.toBe(
          `/admin/channels#${fragment}`,
        );
        await link.click();
        await channelSettingsHeading(label).waitFor();
      },
    );
  });

  describe('command palette', () => {
    test.each([
      ['channelInstructions.msteams', 'Microsoft Teams'],
      ['channelInstructions.slack_webhook', 'Slack Incoming Webhook'],
      ['discordWebhook.enabled', 'Discord Incoming Webhook'],
    ])(
      'jumping to %s opens the %s channel card',
      async (settingPath, label) => {
        await open('/admin');
        await page.keyboard.press('Control+K');
        await page
          .getByPlaceholder('Search pages and settings…')
          .fill(settingPath);
        await page.getByText(settingPath, { exact: true }).first().click();
        await channelSettingsHeading(label).waitFor();
      },
    );
  });

  describe('Teams app setup', () => {
    function checkRow(name: string) {
      return page.locator('li').filter({ hasText: name });
    }

    test('download reports the missing tenant, then ships the org app once configured', async () => {
      await open('/admin/connectors#teams-sso');
      await expect(
        checkRow('Tab SSO enabled').textContent(),
      ).resolves.toContain('Missing');
      const download = page.getByRole('button', { name: 'Download org app' });
      await expect(download.isDisabled()).resolves.toBe(true);

      await page.getByRole('switch', { name: 'Enable tab SSO' }).click();
      await page
        .getByPlaceholder('SSO app ID')
        .fill('00000000-0000-4000-8000-000000000001');
      await page.getByRole('button', { name: 'Save Teams settings' }).click();
      await page.getByText('Teams settings saved.').waitFor();
      await expect
        .poll(() => checkRow('Tab SSO enabled').textContent())
        .toContain('Ready');
      await expect(checkRow('Tenant ID').textContent()).resolves.toContain(
        'Missing',
      );

      await download.click();
      await page
        .getByText('Download failed: Teams tenant ID is not configured.')
        .waitFor();

      await open('/admin/channels#teams');
      await page
        .getByRole('textbox', { name: 'Tenant ID' })
        .fill('00000000-0000-4000-8000-000000000002');
      await page.getByRole('button', { name: 'Save channel settings' }).click();
      await page.getByText('Channel settings saved.').waitFor();

      await open('/admin/connectors#teams-sso');
      for (const name of [
        'Tab SSO enabled',
        'Tenant ID',
        'SSO app ID',
        'App ID URI',
        'Scope',
      ]) {
        await expect
          .poll(() => checkRow(name).textContent())
          .toContain('Ready');
      }
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        download.click(),
      ]);
      expect(file.suggestedFilename()).toBe('hybridclaw-teams-app.zip');
      const zip = fs.readFileSync(await file.path());
      expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
      expect(zip.includes('manifest.json')).toBe(true);
    });
  });

  describe('credentials', () => {
    test('a stored secret shows its length, fingerprint and rotation, never its value', async () => {
      const value = 'e2e-secret-value-1234';
      await open('/admin/credentials?tab=secrets');
      await page.getByRole('button', { name: 'Add secret' }).click();
      await page
        .getByRole('dialog')
        .getByLabel('Name')
        .fill('E2E_CONSOLE_SECRET');
      await page.getByRole('dialog').getByLabel('Value').fill(value);
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Add secret' })
        .click();

      const row = page
        .getByRole('region', { name: 'Set' })
        .getByRole('row')
        .filter({ hasText: 'E2E_CONSOLE_SECRET' });
      await row.waitFor();
      const text = (await row.textContent()) ?? '';
      expect(text).toContain(`${value.length} bytes`);
      expect(text).toMatch(/sha256:[0-9a-f]{12}/);
      expect(text).toContain('just now');
      await expect(page.content()).resolves.not.toContain(value);
    });

    test('an unused, non-expiring API token reads "never" for last use and expiry', async () => {
      await api('/api/admin/tokens', {
        method: 'POST',
        body: { label: 'e2e-console-token', actions: ['admin:read'] },
      });
      await open('/admin/credentials?tab=api-tokens');
      const row = page
        .getByRole('row')
        .filter({ hasText: 'e2e-console-token' });
      const cells = row.getByRole('cell');
      await row.waitFor();
      const headers = await page.getByRole('columnheader').allTextContents();
      const cellText = await cells.allTextContents();
      const column = (name: string) => cellText[headers.indexOf(name)];
      expect(column('Created')).toBe('just now');
      expect(column('Last used')).toBe('never');
      expect(column('Expires')).toBe('never');
    });
  });

  describe('scheduler', () => {
    test.each([
      ['msteams', 'Microsoft Teams'],
      ['telegram', 'Telegram'],
      ['email', 'Email'],
    ])(
      'a job delivering to an unconfigured %s channel keeps it as "%s (current)"',
      async (channel, label) => {
        const id = `e2e-${channel}-delivery`;
        await api('/api/admin/scheduler', {
          method: 'PUT',
          body: {
            job: {
              id,
              name: `E2E ${label} delivery`,
              description: '',
              agentId: 'main',
              boardStatus: 'backlog',
              maxRetries: null,
              enabled: false,
              schedule: {
                kind: 'cron',
                at: null,
                everyMs: null,
                expr: '0 9 * * 1',
                tz: 'UTC',
              },
              action: { kind: 'agent_turn', message: 'Ping.' },
              delivery: {
                kind: 'channel',
                channel,
                to: 'e2e-target',
                webhookUrl: '',
              },
            },
          },
        });
        await open(`/admin/scheduler?jobId=${id}`);
        const channelType = page.getByLabel('Channel type');
        await expect
          .poll(() => channelType.locator('option').allTextContents())
          .toContain(`${label} (current)`);
        await expect(channelType.inputValue()).resolves.toBe(channel);
      },
    );
  });

  describe('skills', () => {
    test('skill detail shows package file sizes and its stored credential metadata', async () => {
      const value = 'e2e-hetzner-token';
      await api('/api/admin/secrets/HETZNER_DNS_API_TOKEN', {
        method: 'PUT',
        body: { value },
      });
      await open('/admin/skills/hetzner-dns');

      const credential = page
        .locator('.skill-credential-row')
        .filter({ hasText: 'HETZNER_DNS_API_TOKEN' });
      await expect
        .poll(() => credential.textContent())
        .toContain(`${value.length} bytes · rotated just now`);
      await expect(
        credential.locator('.skill-credential-fingerprint').textContent(),
      ).resolves.toMatch(/^sha256:[0-9a-f]{12}$/);

      const skillMdKiB =
        fs.statSync(path.join(REPO, 'skills', 'hetzner-dns', 'SKILL.md')).size /
        1024;
      await expect(
        page
          .locator('.skill-file-row')
          .filter({ hasText: /^SKILL\.md/ })
          .locator('.skill-file-meta')
          .textContent(),
      ).resolves.toBe(
        `file · ${skillMdKiB.toFixed(skillMdKiB >= 10 ? 0 : 1)} KiB`,
      );
    });
  });

  describe('logs', () => {
    function logFile(name: string) {
      return page.locator('.selectable-row').filter({ hasText: name });
    }

    function sizeValue() {
      return page
        .locator('.key-value-grid > div')
        .filter({ hasText: 'Size' })
        .locator('strong');
    }

    test('log files report a human-readable size, or missing when absent', async () => {
      await open('/admin/logs');
      await logFile('Gateway').click();
      await expect
        .poll(() => sizeValue().textContent())
        .toMatch(/^(\d+ B|\d+(\.\d)? (KiB|MiB|GiB))$/);

      await logFile('Model responses').click();
      await expect.poll(() => sizeValue().textContent()).toBe('missing');
      await page.getByText('This log file is not available yet.').waitFor();
      await expect(page.locator('.log-viewer').count()).resolves.toBe(0);
    });
  });

  describe('distill', () => {
    test('an uploaded source shows its size and its corpus document downloads intact', async () => {
      const sourceText = `${'The e2e subject writes short, plain sentences. '.repeat(30)}\n`;
      await open('/admin/distill');
      await page.getByLabel('Alias', { exact: true }).fill('e2e-subject');
      await page.getByLabel('Name', { exact: true }).fill('E2E Subject');
      await page.getByRole('button', { name: 'Save Subject' }).click();
      await page.getByLabel('Granted by').fill('E2E Operator');
      await page
        .getByLabel('Statement')
        .fill('Consent recorded for the e2e run.');
      await page.getByRole('button', { name: 'Record Consent' }).click();

      await page.locator('input[type="file"]').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(sourceText),
      });
      await page.getByRole('button', { name: 'Upload Files' }).click();
      await page
        .getByText(
          `notes.txt · auto · ${(sourceText.length / 1024).toFixed(1)} KiB`,
        )
        .first()
        .waitFor();

      await page.getByRole('button', { name: 'Start Distill' }).click();
      const downloadButton = page
        .getByRole('button', { name: /^Download / })
        .first();
      await downloadButton.waitFor();
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        downloadButton.click(),
      ]);
      const content = fs.readFileSync(await file.path(), 'utf-8');
      expect(content).toContain(
        'The e2e subject writes short, plain sentences.',
      );
    });
  });
});
