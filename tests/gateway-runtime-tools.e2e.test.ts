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
 * Cloud host-sandbox deployments execute skills inside the gateway image, so
 * every library in the shared runtime tool inventory has to load there, not
 * only in the standalone agent image. Uses one long-lived container with
 * `docker exec`, like the agent image suite.
 */

const { image: IMAGE, enabled: DOCKER_E2E } = dockerE2eGate(
  'HYBRIDCLAW_E2E_IMAGE',
);

// Prefix must not share a stem with the other gateway suites: their stale
// container cleanup matches by name prefix and suites run concurrently.
const SUITE_PREFIX = 'tools';
const CONTAINER_NAME = `hc-e2e-${SUITE_PREFIX}-${process.pid}`;

let exec: (cmd: string, timeoutMs?: number) => string;

describe.skipIf(!DOCKER_E2E)(
  'gateway image runtime tools',
  { timeout: 30_000 },
  () => {
    const inventory = readRuntimeToolInventory();

    beforeAll(() => {
      cleanupStaleContainers(SUITE_PREFIX);
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

    test.each([...inventory.pip.keys()])(
      'python package %s is importable',
      (pkg) => {
        const result = exec(
          `python3 -c "import ${pythonImportName(pkg)}; print('ok')"`,
        );
        expect(result).toBe('ok');
      },
    );

    // Resolved from a workspace-style directory, not /app, because that is
    // where agent-written scripts run: only NODE_PATH can find the tools.
    test.each([...inventory.npm.keys()])(
      'npm package %s is requireable outside /app',
      (pkg) => {
        const result = exec(
          `sh -c "cd /workspace && node -e \\"require('${pkg}'); console.log('ok')\\""`,
        );
        expect(result).toBe('ok');
      },
    );

    test('xlsx resolves to @e965/xlsx', () => {
      const result = exec(
        `sh -c "cd /workspace && node -e \\"console.log(typeof require('xlsx').utils.book_new)\\""`,
      );
      expect(result).toBe('function');
    });

    test('image-size resolves to the dependency-free stub', () => {
      const result = exec(
        `sh -c "cd /workspace && node -e \\"console.log(require('image-size/package.json').version)\\""`,
      );
      expect(result).toBe('0.0.0-stub');
      const nested = exec(
        `sh -c "test ! -e ${RUNTIME_TOOLS_TARGET}/node_modules/pptxgenjs/node_modules/image-size && echo absent"`,
      );
      expect(nested).toBe('absent');
    });

    test('pptxgenjs writes a deck from a workspace script', () => {
      const script = [
        "const P = require('pptxgenjs');",
        'const p = new P();',
        "p.addSlide().addText('ok', { x: 1, y: 1 });",
        "p.writeFile({ fileName: '/tmp/e2e.pptx' })",
        "  .then(() => console.log(require('node:fs').statSync('/tmp/e2e.pptx').size > 0 ? 'ok' : 'empty'));",
      ].join(' ');
      const result = exec(`sh -c "cd /workspace && node -e \\"${script}\\""`);
      expect(result).toBe('ok');
    });
  },
);
