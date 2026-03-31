import { describe, test, expect, afterAll, beforeAll } from 'vitest';
import {
  cleanupStaleContainers,
  startContainer,
  removeContainer,
} from './helpers/docker-test-setup.js';

/**
 * Uses a single long-lived container with `docker exec` instead of spawning
 * separate containers per test (~22s -> ~3s).
 */

const DOCKER_E2E = process.env.HYBRIDCLAW_RUN_DOCKER_E2E === '1';
const IMAGE =
  process.env.HYBRIDCLAW_E2E_AGENT_IMAGE || 'hybridclaw-agent:preflight';

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

describe.skipIf(!DOCKER_E2E)('agent container image', { timeout: 30_000 }, () => {
  beforeAll(() => {
    cleanupStaleContainers('agent');
    const container = startContainer({
      image: IMAGE,
      name: CONTAINER_NAME,
      entrypoint: ['sleep', 'infinity'],
    });
    exec = container.exec;
  });

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

  // ── Python packages ─────────────────────────────────────────────────

  const pythonPackages = [
    'pypdf',
    'pdfplumber',
    'pdf2image',
    'reportlab',
    'PIL',
  ];

  test.each(pythonPackages)('python package %s is importable', (pkg) => {
    const result = exec(`python3 -c "import ${pkg}; print('ok')"`)
    expect(result).toBe('ok');
  });

  // ── Global npm packages ─────────────────────────────────────────────

  const npmPackages = [
    'docx',
    'pptxgenjs',
    'csv-parse',
    'iconv-lite',
    'xlsx-populate',
  ];

  test.each(npmPackages)('npm package %s is requireable', (pkg) => {
    const result = exec(`node -e "require('${pkg}'); console.log('ok')"`)
    expect(result).toBe('ok');
  });

  // ── Browser automation ──────────────────────────────────────────────

  test('playwright chromium is installed', () => {
    const moduleResult = exec(
      'node -e "var p = require(\'playwright\'); console.log(typeof p.chromium.launch)"',
    );
    expect(moduleResult).toBe('function');

    const binaryResult = exec(
      'find /ms-playwright -name chrome-headless-shell -o -name chrome 2>/dev/null | head -1',
    );
    expect(binaryResult.length).toBeGreaterThan(0);
  });

  // ── LibreOffice (full runtime target) ───────────────────────────────

  test('libreoffice is installed', () => {
    expect(hasCommand('libreoffice')).toBe(true);
  });
});
