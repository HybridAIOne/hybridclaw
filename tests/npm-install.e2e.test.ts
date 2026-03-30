import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, afterAll, beforeAll } from 'vitest';
import { getAvailablePort, waitForHealth } from './helpers/docker-test-setup.js';

/**
 * E2E test that exercises the real npm-install-to-first-request user journey:
 *
 *   npm pack → npm install -g → hybridclaw gateway start → /health → /docs
 *
 * This mirrors what a user does after `npm install -g @hybridaione/hybridclaw`
 * followed by the Getting Started quickstart flow.
 *
 * Requires:
 *   HYBRIDCLAW_RUN_NPM_E2E=1   — gate flag (CI sets this in the npm-e2e job)
 *
 * The test uses a temporary npm prefix so it does not pollute the system.
 * A dummy API key is used since we only need the gateway to start and serve
 * static content — no LLM calls are made.
 *
 * All child process calls use only hardcoded strings (no user input).
 */

const NPM_E2E = process.env.HYBRIDCLAW_RUN_NPM_E2E === '1';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

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

describe.skipIf(!NPM_E2E)('npm install user journey', () => {
  beforeAll(async () => {
    HOST_PORT = await getAvailablePort(9198);
    GATEWAY_URL = `http://127.0.0.1:${HOST_PORT}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-npm-e2e-'));
    fs.mkdirSync(npmPrefix(), { recursive: true });
    fs.mkdirSync(dataDir(), { recursive: true });

    // Step 1: Pack the current build into a tarball
    // All paths are hardcoded — no injection risk.
    const packOutput = execSync('npm pack --pack-destination ' + tempDir, {
      encoding: 'utf-8',
      timeout: 120_000,
    }).trim();
    const tarballName = packOutput.split('\n').pop()!.trim();
    const tarball = path.join(tempDir, tarballName);

    // Step 2: Install globally into temp prefix
    // (mirrors: npm install -g @hybridaione/hybridclaw)
    execSync(
      `npm install -g "${tarball}" --prefix "${npmPrefix()}"`,
      {
        encoding: 'utf-8',
        timeout: 120_000,
        env: { ...process.env, HOME: tempDir },
      },
    );

    // Step 3: Write config with a dynamically allocated port
    fs.writeFileSync(
      path.join(dataDir(), 'config.json'),
      JSON.stringify({
        ops: { healthPort: HOST_PORT, healthHost: '127.0.0.1' },
      }),
    );

    // Step 4: Start the gateway from the installed package
    // (mirrors: hybridclaw gateway start --foreground --sandbox=host)
    gatewayProcess = spawn(
      'node',
      [installedCliPath(), 'gateway', 'start', '--foreground', '--sandbox=host'],
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
    gatewayProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('--- npm-installed gateway stderr ---\n', stderr);
      }
    });

    await waitForHealth(`${GATEWAY_URL}/health`, STARTUP_TIMEOUT_MS);
  }, STARTUP_TIMEOUT_MS + 150_000);

  afterAll(() => {
    if (gatewayProcess) {
      gatewayProcess.kill('SIGTERM');
      gatewayProcess = null;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ── CLI binary works ────────────────────────────────────────────────

  test('hybridclaw --version runs from installed package', () => {
    // All paths are hardcoded constants — no injection risk.
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

  test('/ serves the landing page with unique title', async () => {
    const res = await fetch(GATEWAY_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>HybridClaw \u2014 Enterprise AI Digital Coworker</title>');
  });

  test('/chat serves the chat SPA', async () => {
    const res = await fetch(`${GATEWAY_URL}/chat`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>HybridClaw Chat</title>');
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
