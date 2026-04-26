import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupStaleContainers,
  getAvailablePort,
  removeContainer,
  startContainer,
  waitForHealth,
} from './helpers/docker-test-setup.js';

/**
 * When HYBRIDAI_API_KEY is set (CI secret), the gateway uses a real key and
 * provider health probes and the chat API test hit the live API. Without it,
 * a dummy key lets the gateway start for static-content and endpoint tests.
 */

const DOCKER_E2E = process.env.HYBRIDCLAW_RUN_DOCKER_E2E === '1';
const IMAGE = process.env.HYBRIDCLAW_E2E_IMAGE || 'hybridclaw-gateway:e2e';
const CI_FALLBACK_KEY = 'hai-ci-placeholder-not-a-real-key';
const API_KEY = process.env.HYBRIDAI_API_KEY || CI_FALLBACK_KEY;
const HAS_REAL_KEY = !!process.env.HYBRIDAI_API_KEY;
const WEB_API_TOKEN = 'e2e-test-token';
const CONTAINER_NAME = `hc-e2e-gw-${process.pid}`;
const STARTUP_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 5_000;

let HOST_PORT: number;
let GATEWAY_URL: string;

describe.skipIf(!DOCKER_E2E)('gateway Docker image', () => {
  beforeAll(async () => {
    cleanupStaleContainers('gw');

    HOST_PORT = await getAvailablePort(9199);
    GATEWAY_URL = `http://127.0.0.1:${HOST_PORT}`;

    startContainer({
      image: IMAGE,
      name: CONTAINER_NAME,
      port: { host: HOST_PORT, container: 9090 },
      env: {
        HYBRIDCLAW_ACCEPT_TRUST: 'true',
        HEALTH_HOST: '0.0.0.0',
        HYBRIDAI_API_KEY: API_KEY,
        WEB_API_TOKEN: WEB_API_TOKEN,
      },
    });

    try {
      await waitForHealth(`${GATEWAY_URL}/health`, STARTUP_TIMEOUT_MS);
    } catch (err) {
      try {
        const logs = execSync(`docker logs ${CONTAINER_NAME}`, {
          encoding: 'utf-8',
          timeout: 5_000,
        });
        console.error('--- gateway container logs ---\n', logs);
      } catch {
        // ignore
      }
      throw err;
    }
  }, STARTUP_TIMEOUT_MS + 10_000);

  afterAll(() => {
    removeContainer(CONTAINER_NAME);
  });

  // ── Runtime file checks ──────────────────────────────────────────────

  const requiredFiles = [
    // Browsable docs (markdown source)
    'docs/content/README.md',
    'docs/content/getting-started/README.md',
    'docs/content/getting-started/installation.md',
    'docs/content/getting-started/quickstart.md',
    'docs/content/getting-started/authentication.md',
    // SPA entry points
    'docs/index.html',
    'docs/agents.html',
    // Admin console
    'console/dist/index.html',
    // Container runtime
    'container/dist/index.js',
    'container/shared/model-names.js',
    // Agent templates and skills
    'templates/SOUL.md',
    'templates/TOOLS.md',
    'skills/hybridclaw-help/SKILL.md',
    // Security docs (required by trust acceptance)
    'SECURITY.md',
    'TRUST_MODEL.md',
  ];

  test.each(requiredFiles)('image contains %s', (filePath) => {
    const result = execSync(
      `docker exec ${CONTAINER_NAME} test -f ${filePath} && echo exists`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    expect(result).toBe('exists');
  });

  // ── Native module checks ────────────────────────────────────────────

  test('node-pty native binary loads', () => {
    const result = execSync(
      `docker exec ${CONTAINER_NAME} node -e "require('node-pty')" && echo ok`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    expect(result).toBe('ok');
  });

  test('amd64 image includes signal-cli for admin Signal QR linking', () => {
    const arch = execSync(`docker exec ${CONTAINER_NAME} uname -m`, {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    if (arch !== 'x86_64') {
      return;
    }

    const result = execSync(
      `docker exec ${CONTAINER_NAME} signal-cli --version`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    expect(result).toContain('signal-cli');
  });

  // ── HTTP endpoint checks ─────────────────────────────────────────────

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

  test('/docs/getting-started renders section page', async () => {
    const res = await fetch(`${GATEWAY_URL}/docs/getting-started`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Getting Started');
    expect(html).toContain('authentication');
  });

  test('/docs/getting-started/README.md serves raw markdown', async () => {
    const res = await fetch(`${GATEWAY_URL}/docs/getting-started/README.md`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('# Getting Started');
  });

  test('/ redirects to chat (auth enforced in container)', async () => {
    const res = await fetch(GATEWAY_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/chat');
  });

  test('/about serves the landing page', async () => {
    const res = await fetch(`${GATEWAY_URL}/about`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<title>HybridClaw \u2014 Enterprise AI Digital Coworker</title>',
    );
  });

  test('/chat redirects to login (auth enforced in container)', async () => {
    const res = await fetch(`${GATEWAY_URL}/chat`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/login/);
  });

  test('/agents redirects to login (auth enforced in container)', async () => {
    const res = await fetch(`${GATEWAY_URL}/agents`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/login/);
  });

  test('image contains agents SPA with correct title', () => {
    const result = execSync(
      `docker exec ${CONTAINER_NAME} sh -c 'grep -m1 -o "<title>[^<]*</title>" docs/agents.html'`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    expect(result).toBe('<title>HybridClaw Agents</title>');
  });

  test('/admin redirects to login (auth enforced in container)', async () => {
    const res = await fetch(`${GATEWAY_URL}/admin`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/login/);
  });

  // ── Legacy route redirects ──────────────────────────────────────────

  test('/chat.html 301-redirects to the React /chat console', async () => {
    const res = await fetch(`${GATEWAY_URL}/chat.html`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/chat');
  });

  test('/development redirects to /docs', async () => {
    const res = await fetch(`${GATEWAY_URL}/development`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/docs');
    expect(res.headers.get('x-hybridclaw-docs-redirect')).toBe('legacy');
  });

  test('/development/getting-started redirects to /docs/getting-started', async () => {
    const res = await fetch(`${GATEWAY_URL}/development/getting-started`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/docs/getting-started');
    expect(res.headers.get('x-hybridclaw-docs-redirect')).toBe('legacy');
  });

  // ── Provider health (real key only) ──────────────────────────────────

  test.skipIf(!HAS_REAL_KEY)(
    '/health reports HybridAI provider reachable',
    async () => {
      await waitForHealth(`${GATEWAY_URL}/health`, 30_000, (body) => {
        const ph = body as {
          providerHealth?: { hybridai?: { reachable: boolean } };
        };
        return ph.providerHealth?.hybridai?.reachable === true;
      });
    },
  );

  // ── Chat API: send a message, get a response (real key only) ────────

  test.skipIf(!HAS_REAL_KEY)(
    'POST /api/chat returns a response to a simple message',
    async () => {
      const res = await fetch(`${GATEWAY_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${WEB_API_TOKEN}`,
        },
        body: JSON.stringify({ content: 'Reply with exactly: e2e-ok' }),
        signal: AbortSignal.timeout(30_000),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        result: string | null;
        sessionId?: string;
      };
      expect(body.status).toBe('success');
      expect(typeof body.result).toBe('string');
      expect(body.result!.length).toBeGreaterThan(0);
      expect(body.sessionId).toBeTruthy();
    },
    60_000,
  );
});
