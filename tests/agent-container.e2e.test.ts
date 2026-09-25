import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cleanupStaleContainers,
  dockerE2eGate,
  removeContainer,
  startContainer,
} from './helpers/docker-test-setup.js';
import {
  pythonImportName,
  readRuntimeToolInventory,
  RUNTIME_TOOLS_TARGET,
} from './helpers/runtime-tools-inventory.js';

/**
 * Uses a single long-lived container with `docker exec` instead of spawning
 * separate containers per test (~22s -> ~3s).
 */

const { image: IMAGE, enabled: DOCKER_E2E } = dockerE2eGate(
  'HYBRIDCLAW_E2E_AGENT_IMAGE',
);

const CONTAINER_NAME = `hc-e2e-agent-${process.pid}`;

let exec: (cmd: string, timeoutMs?: number) => string;

function hasCommand(cmd: string): boolean {
  try {
    exec(`which ${cmd}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('is not running') || msg.includes('No such container')) {
      throw err;
    }
    return false;
  }
}

describe.skipIf(!DOCKER_E2E)(
  'agent container image',
  { timeout: 30_000 },
  () => {
    beforeAll(() => {
      cleanupStaleContainers('agent');
      const container = startContainer({
        image: IMAGE,
        name: CONTAINER_NAME,
        entrypoint: ['sleep', 'infinity'],
      });
      exec = container.exec;
    }, 30_000);

    afterAll(() => {
      removeContainer(CONTAINER_NAME);
    });

    // ── Core runtime ────────────────────────────────────────────────────

    test('node is available', () => {
      const version = exec('node --version');
      expect(version).toMatch(/^v22\./);
    });

    test('compiled agent entrypoint exists', () => {
      const result = exec('test -f /app/dist/index.js && echo exists');
      expect(result).toBe('exists');
    });

    // ── CLI tools ───────────────────────────────────────────────────────

    const requiredCommands = [
      'git',
      'curl',
      'rg',
      'python3',
      'pip3',
      'pandoc',
      'pdftotext',
      'qpdf',
    ];

    test.each(requiredCommands)('%s is installed', (cmd) => {
      expect(hasCommand(cmd)).toBe(true);
    });

    // ── Python packages (shared runtime tool inventory) ────────────────

    const inventory = readRuntimeToolInventory();

    test.each([...inventory.pip.keys()])(
      'python package %s is importable',
      (pkg) => {
        const result = exec(
          `python3 -c "import ${pythonImportName(pkg)}; print('ok')"`,
        );
        expect(result).toBe('ok');
      },
    );

    // ── Global npm packages (shared runtime tool inventory) ────────────

    test.each([...inventory.npm.keys()])(
      'npm package %s is requireable',
      (pkg) => {
        const result = exec(`node -e "require('${pkg}'); console.log('ok')"`);
        expect(result).toBe('ok');
      },
    );

    test('image-size resolves to the dependency-free stub', () => {
      const result = exec(
        `node -e "console.log(require('image-size/package.json').version)"`,
      );
      expect(result).toBe('0.0.0-stub');
      const nested = exec(
        `sh -c "test ! -e ${RUNTIME_TOOLS_TARGET}/node_modules/pptxgenjs/node_modules/image-size && echo absent"`,
      );
      expect(nested).toBe('absent');
    });

    // ── Browser automation ──────────────────────────────────────────────

    test('playwright chromium launches and renders a page', () => {
      const result = exec(
        'node -e "(async () => { const { chromium } = require(\'playwright\'); const browser = await chromium.launch({ headless: true }); try { const page = await browser.newPage(); await page.setContent(\'<h1>Browser ready</h1>\'); console.log(await page.locator(\'h1\').textContent()); } finally { await browser.close(); } })().catch(error => { console.error(error); process.exitCode = 1; });"',
      );
      expect(result).toBe('Browser ready');
    });

    // ── LibreOffice (full runtime target) ───────────────────────────────

    test('libreoffice is installed', () => {
      expect(hasCommand('libreoffice')).toBe(true);
    });
  },
);
