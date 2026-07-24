import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

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

function expectSpreadsheetRuntimeTools(runtime: string): void {
  expect(runtime).toMatch(/\bpython3\b/);
  expect(runtime).toMatch(/\bpython3-pip\b/);
  expect(runtime).toMatch(/\bpython-is-python3\b/);
  expect(runtime).toMatch(/\bunzip\b/);
  expect(runtime).toMatch(/\bfile\b/);
  expect(runtime).toContain('openpyxl==3.1.5');
}

function expectRuntimePipInstallable(runtime: string): void {
  // Agents must be able to `pip install` at runtime: Debian's PEP 668 marker
  // otherwise rejects bare installs, and without python3-venv the venv escape
  // hatch fails too (no ensurepip).
  expect(runtime).toMatch(/\bpython3-venv\b/);
  expect(runtime).toContain('PIP_BREAK_SYSTEM_PACKAGES=1');
}

describe('Docker runtime tool parity', () => {
  test('gateway host-sandbox runtime includes spreadsheet inspection tools', () => {
    const runtime = runtimeStage(readRepoFile('Dockerfile'), 'runtime');
    expectSpreadsheetRuntimeTools(runtime);
    expectRuntimePipInstallable(runtime);
    expect(runtime).toContain(
      'NODE_PATH=/usr/local/lib/node_modules:/app/node_modules:/app/container/node_modules',
    );
    const packageJson = JSON.parse(
      readRepoFile('package.json'),
    ) as Record<string, Record<string, string>>;
    expect(packageJson.dependencies?.['@e965/xlsx']).toBe('0.20.3');
    expect(packageJson.dependencies?.['xlsx-populate']).toBe('1.21.0');
    expect(runtime).toContain(
      'ln -s /app/node_modules/@e965/xlsx /app/node_modules/xlsx',
    );
  });

  test('standalone agent runtime includes spreadsheet inspection tools', () => {
    const runtime = runtimeStage(
      readRepoFile('container/Dockerfile'),
      'runtime-lite',
    );
    expectSpreadsheetRuntimeTools(runtime);
    expectRuntimePipInstallable(runtime);
    expect(runtime).toContain('@e965/xlsx@0.20.3');
    expect(runtime).toContain('xlsx-populate@1.21.0');
    expect(runtime).toContain(
      'ln -s /usr/local/lib/node_modules/@e965/xlsx /usr/local/lib/node_modules/xlsx',
    );
  });
});
