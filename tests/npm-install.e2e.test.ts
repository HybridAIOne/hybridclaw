import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  getAvailablePort,
  waitForHealth,
} from './helpers/docker-test-setup.js';

/**
 * Exercises the real npm-install-to-first-request user journey:
 * npm pack → npm install -g → hybridclaw gateway start → /health → /docs
 *
 * Uses a temporary npm prefix and a dummy API key (no LLM calls).
 */

const NPM_E2E = process.env.HYBRIDCLAW_RUN_NPM_E2E === '1';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
// CI maintenance (2026-09-22): allow shutdown plus removal of both installed
// dependency trees on slower runners; startup/request timeouts stay separate.
const CLEANUP_TIMEOUT_MS = 60_000;

let tempDir: string;
let gatewayProcess: ChildProcess | null = null;
let HOST_PORT: number;
let GATEWAY_URL: string;

function npmPrefix(): string {
  return path.join(tempDir, 'npm-global');
}

function dataDir(): string {
  return path.join(tempDir, 'hybridclaw-data');
}

function installedCliPath(): string {
  return path.join(
    npmPrefix(),
    'lib',
    'node_modules',
    '@hybridaione',
    'hybridclaw',
    'dist',
    'cli.js',
  );
}

const WEB_API_TOKEN = 'npm-e2e-web-token';

function installedCliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: tempDir,
    HYBRIDCLAW_DATA_DIR: dataDir(),
    HYBRIDCLAW_ACCEPT_TRUST: 'true',
    HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
  };
}

function verifyPnpmInstallBlocksExoticSubdeps(tarball: string): void {
  const pnpmHome = path.join(tempDir, 'pnpm-home');
  const pnpmGlobalDir = path.join(tempDir, 'pnpm-global');
  fs.mkdirSync(pnpmHome, { recursive: true });
  fs.mkdirSync(pnpmGlobalDir, { recursive: true });

  execSync(
    `npx --yes pnpm@10.23.0 add -g "${tarball}" --config.block-exotic-subdeps=true --global-dir "${pnpmGlobalDir}" --dir "${tempDir}"`,
    {
      encoding: 'utf-8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${pnpmHome}${path.delimiter}${process.env.PATH ?? ''}`,
        PNPM_HOME: pnpmHome,
      },
    },
  );
}

describe.skipIf(!NPM_E2E)('npm install user journey', () => {
  beforeAll(async () => {
    HOST_PORT = await getAvailablePort(9198);
    GATEWAY_URL = `http://127.0.0.1:${HOST_PORT}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-npm-e2e-'));
    fs.mkdirSync(npmPrefix(), { recursive: true });
    fs.mkdirSync(dataDir(), { recursive: true });

    const packOutput = execSync(`npm pack --pack-destination "${tempDir}"`, {
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
    const tarballName = packOutput.split('\n').pop()?.trim();
    if (!tarballName) {
      throw new Error(
        `npm pack produced no output. Full output: ${packOutput}`,
      );
    }
    const tarball = path.join(tempDir, tarballName);

    verifyPnpmInstallBlocksExoticSubdeps(tarball);

    execSync(`npm install -g "${tarball}" --prefix "${npmPrefix()}"`, {
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, HOME: tempDir },
    });

    fs.writeFileSync(
      path.join(dataDir(), 'config.json'),
      JSON.stringify({
        ops: {
          healthPort: HOST_PORT,
          healthHost: '127.0.0.1',
          webApiToken: WEB_API_TOKEN,
        },
      }),
    );

    // The install-on-demand distill plugin, by id from the installed package.
    execSync(`node "${installedCliPath()}" plugin install distill`, {
      encoding: 'utf-8',
      timeout: 60_000,
      env: installedCliEnv(),
    });

    gatewayProcess = spawn(
      'node',
      [
        installedCliPath(),
        'gateway',
        'start',
        '--foreground',
        '--sandbox=host',
      ],
      {
        env: {
          ...process.env,
          HOME: tempDir,
          HYBRIDCLAW_DATA_DIR: dataDir(),
          HYBRIDCLAW_ACCEPT_TRUST: 'true',
          HYBRIDAI_API_KEY: 'hai-npm-e2e-placeholder',
          HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
        },
        stdio: 'pipe',
      },
    );

    let stderr = '';
    gatewayProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Drain stdout too: an unread pipe blocks the gateway once its ~64KB
    // buffer fills, deadlocking the suite on chatty startups.
    gatewayProcess.stdout?.resume();
    gatewayProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('--- npm-installed gateway stderr ---\n', stderr);
      }
    });

    await waitForHealth(`${GATEWAY_URL}/health`, STARTUP_TIMEOUT_MS);
  }, STARTUP_TIMEOUT_MS + 150_000);

  afterAll(async () => {
    if (gatewayProcess) {
      const proc = gatewayProcess;
      gatewayProcess = null;
      proc.kill('SIGTERM');

      const exited = await Promise.race([
        new Promise<boolean>((resolve) => proc.on('exit', () => resolve(true))),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);

      if (!exited) {
        console.warn(
          '[cleanup] Gateway did not exit after SIGTERM, sending SIGKILL',
        );
        proc.kill('SIGKILL');
        // Wait for the kill to land before directory removal races a process that
        // is still writing under tempDir (HOME, npm prefix, data dir).
        await Promise.race([
          new Promise<void>((resolve) => proc.on('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
    if (tempDir) {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[cleanup] Failed to remove temp dir:', err);
      }
    }
  }, CLEANUP_TIMEOUT_MS);

  // ── CLI binary works ────────────────────────────────────────────────

  test('hybridclaw --version runs from installed package', () => {
    const result = execSync(`node "${installedCliPath()}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // ── Gateway serves content from npm-installed package ───────────────

  test('/health returns ok with semver version', async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('/docs renders Getting Started content', async () => {
    const res = await fetch(`${GATEWAY_URL}/docs`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Getting Started');
    expect(html).toContain('Installation');
  });

  test('/ redirects to chat', async () => {
    const res = await fetch(GATEWAY_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/chat');
  });

  test('/about serves the landing page with unique title', async () => {
    const res = await fetch(`${GATEWAY_URL}/about`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<title>HybridClaw \u2014 Enterprise AI Digital Coworker</title>',
    );
  });

  test('/chat serves the console SPA (chat is top-level, not under /admin)', async () => {
    const res = await fetch(`${GATEWAY_URL}/chat`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>HybridClaw Chat</title>');
  });

  test('the distill plugin installs by id and runs from the installed package', () => {
    const packageRoot = path.dirname(path.dirname(installedCliPath()));
    expect(fs.existsSync(path.join(dataDir(), 'plugins', 'distill'))).toBe(
      false,
    );
    const config = JSON.parse(
      fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf-8'),
    ) as { plugins?: { list?: Array<{ id: string; enabled: boolean }> } };
    expect(config.plugins?.list).toContainEqual(
      expect.objectContaining({ id: 'distill', enabled: true }),
    );
    expect(
      fs.existsSync(path.join(packageRoot, 'plugins', 'distill', 'src')),
    ).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, 'dist', 'distill'))).toBe(
      false,
    );

    const help = execSync(`node "${installedCliPath()}" help`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: installedCliEnv(),
    });
    expect(help).toMatch(/Plugin commands:\n\s+coworker\s/);
    const usage = execSync(`node "${installedCliPath()}" coworker --help`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: installedCliEnv(),
    });
    expect(usage.startsWith('Usage: hybridclaw coworker')).toBe(true);
  });

  test('the gateway serves the distill admin API from the installed plugin', async () => {
    const res = await fetch(`${GATEWAY_URL}/api/admin/distill`, {
      headers: { Authorization: `Bearer ${WEB_API_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjects: unknown[] };
    expect(body.subjects).toEqual([]);
  });

  test('/admin serves the console (host mode, no container auth)', async () => {
    const res = await fetch(`${GATEWAY_URL}/admin`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>HybridClaw Admin</title>');
  });
});
