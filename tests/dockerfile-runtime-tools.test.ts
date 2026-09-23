import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  readRuntimeToolInventory,
  RUNTIME_TOOLS_DIR,
  RUNTIME_TOOLS_TARGET,
  type RuntimeToolInventory,
} from './helpers/runtime-tools-inventory.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

function runtimeStage(dockerfile: string, stageName: string): string {
  const marker = ` AS ${stageName}`;
  const start = dockerfile.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return dockerfile.slice(start + marker.length);
}

function expectSystemRuntimeTools(runtime: string): void {
  expect(runtime).toMatch(/\bpython3\b/);
  expect(runtime).toMatch(/\bpython3-pip\b/);
  expect(runtime).toMatch(/\bpython-is-python3\b/);
  expect(runtime).toMatch(/\bunzip\b/);
  expect(runtime).toMatch(/\bfile\b/);
}

function expectRuntimePipInstallable(runtime: string): void {
  // Agents must be able to `pip install` at runtime: Debian's PEP 668 marker
  // otherwise rejects bare installs, and without python3-venv the venv escape
  // hatch fails too (no ensurepip).
  expect(runtime).toMatch(/\bpython3-venv\b/);
  expect(runtime).toContain('PIP_BREAK_SYSTEM_PACKAGES=1');
}

/**
 * Both runtime stages install the agent tool libraries from the one
 * lockfile-backed manifest directory and carry no inline pins of their own.
 * That is what stops the two images drifting apart: pptxgenjs and reportlab
 * were silently missing from the gateway image while each Dockerfile kept
 * its own list.
 */
function expectManifestInstall(
  runtime: string,
  copySource: string,
  inventory: RuntimeToolInventory,
): void {
  expect(runtime).toContain(`COPY ${copySource}/ ${RUNTIME_TOOLS_TARGET}/`);
  expect(runtime).toContain(
    `--require-hashes \\\n      -r ${RUNTIME_TOOLS_TARGET}/requirements.txt`,
  );
  expect(runtime).toContain(
    `cd ${RUNTIME_TOOLS_TARGET} \\\n    && npm ci --ignore-scripts --omit=dev`,
  );
  expect(runtime).toMatch(
    new RegExp(`NODE_PATH=${RUNTIME_TOOLS_TARGET}/node_modules:`),
  );
  for (const name of inventory.pip.keys()) {
    expect(runtime).not.toContain(`${name}==`);
  }
  for (const name of inventory.npm.keys()) {
    expect(runtime).not.toContain(`${name}@`);
  }
  expect(runtime).not.toMatch(/npm install (-g|--global) (?!npm@)/);
}

describe('Docker runtime tool parity', () => {
  const inventory = readRuntimeToolInventory(repoRoot);

  test('gateway host-sandbox runtime installs the tools manifest', () => {
    const runtime = runtimeStage(readRepoFile('Dockerfile'), 'runtime');
    expectSystemRuntimeTools(runtime);
    expectRuntimePipInstallable(runtime);
    expectManifestInstall(runtime, RUNTIME_TOOLS_DIR, inventory);
    expect(runtime).toContain(
      `NODE_PATH=${RUNTIME_TOOLS_TARGET}/node_modules:/app/node_modules:/app/container/node_modules`,
    );
    expect(runtime).toContain('ARG SIGNAL_CLI_VERSION=0.14.7');
    expect(runtime).toContain(
      '{"dataDir":"/workspace/.data/signal-cli"}',
    );
  });

  test('standalone agent runtime installs the tools manifest', () => {
    const runtime = runtimeStage(
      readRepoFile('container/Dockerfile'),
      'runtime-lite',
    );
    expectSystemRuntimeTools(runtime);
    expectRuntimePipInstallable(runtime);
    // The agent image builds with `container/` as its context.
    expectManifestInstall(runtime, 'tools', inventory);
    expect(runtime).toContain(
      `NODE_PATH=${RUNTIME_TOOLS_TARGET}/node_modules:/app/node_modules`,
    );
  });

  test('gateway package.json does not carry agent-only tool libraries', () => {
    const packageJson = JSON.parse(
      readRepoFile('package.json'),
    ) as Record<string, Record<string, string>>;
    // Kept out of the gateway's own dependency graph on purpose: pptxgenjs
    // declares image-size, which the tools manifest replaces with a stub.
    expect(packageJson.dependencies?.['pptxgenjs']).toBeUndefined();
    expect(packageJson.dependencies?.['image-size']).toBeUndefined();
  });
});

describe('runtime tools manifest', () => {
  const inventory = readRuntimeToolInventory(repoRoot);
  const manifest = JSON.parse(
    readRepoFile(`${RUNTIME_TOOLS_DIR}/package.json`),
  ) as {
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  test('is a private, script-free manifest with exact pins', () => {
    expect(manifest.private).toBe(true);
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    for (const [name, spec] of inventory.npm) {
      expect(
        spec,
        `${name} must be an exact version, npm: alias, or file: spec`,
      ).toMatch(/^(\d+\.\d+\.\d+|npm:.+@\d+\.\d+\.\d+|file:\.\/.+)$/);
    }
  });

  test('pins the libraries the bundled office skills reference', () => {
    expect(inventory.npm.get('pptxgenjs')).toBe('4.0.1');
    expect(inventory.npm.get('docx')).toBeDefined();
    expect(inventory.npm.get('@e965/xlsx')).toBe('0.20.3');
    expect(inventory.npm.get('xlsx')).toBe('npm:@e965/xlsx@0.20.3');
    expect(inventory.npm.get('xlsx-populate')).toBe('1.21.0');
    expect(inventory.pip.get('openpyxl')).toBe('3.1.5');
    expect(inventory.pip.get('reportlab')).toBeDefined();
    expect(inventory.pip.get('pypdf')).toBeDefined();
  });

  test('replaces the unpatched image-size parser with the local stub', () => {
    expect(inventory.npm.get('image-size')).toBe('file:./stubs/image-size');
    expect(manifest.overrides?.['image-size']).toBe('$image-size');
    const lockfile = JSON.parse(
      readRepoFile(`${RUNTIME_TOOLS_DIR}/package-lock.json`),
    ) as { packages: Record<string, { resolved?: string; link?: boolean }> };
    expect(lockfile.packages['node_modules/image-size']).toEqual({
      resolved: 'stubs/image-size',
      link: true,
    });
    expect(
      Object.keys(lockfile.packages).filter((key) =>
        key.endsWith('/node_modules/image-size'),
      ),
    ).toEqual([]);
  });

  test('npm pins match the gateway package.json where both carry a package', () => {
    const packageJson = JSON.parse(
      readRepoFile('package.json'),
    ) as Record<string, Record<string, string>>;
    const shared = [...inventory.npm].filter(
      ([name]) => packageJson.dependencies?.[name] !== undefined,
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const [name, version] of shared) {
      expect(
        { name, version: packageJson.dependencies[name] },
        `${name} is pinned to ${version} in ${RUNTIME_TOOLS_DIR}/package.json`,
      ).toEqual({ name, version });
    }
  });

  test('requirements.txt is the hashed resolution of requirements.in', () => {
    const resolved = readRepoFile(`${RUNTIME_TOOLS_DIR}/requirements.txt`);
    for (const [name, version] of inventory.pip) {
      expect(resolved).toMatch(new RegExp(`^${name}==${version}`, 'm'));
    }
    const pinnedLines = resolved
      .split('\n')
      .filter((line) => /^[a-z0-9_.-]+==/i.test(line));
    expect(pinnedLines.length).toBeGreaterThanOrEqual(inventory.pip.size);
    // --require-hashes refuses any requirement without a hash, so every
    // resolved package must carry at least one.
    const hashCount = (resolved.match(/--hash=sha256:/g) ?? []).length;
    expect(hashCount).toBeGreaterThanOrEqual(pinnedLines.length);
  });
});
