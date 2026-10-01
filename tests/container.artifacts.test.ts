import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import {
  discoverArtifactsSince,
  inferArtifactMimeType,
} from '../container/src/artifacts.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-artifacts-');
useCleanMocks({ resetModules: true, unstubAllEnvs: true });

function writeChart(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'chart.png');
  fs.writeFileSync(filePath, 'png payload');
  return filePath;
}

test('infers OOXML artifact mime types', () => {
  expect(inferArtifactMimeType('report.docx')).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  expect(inferArtifactMimeType('deck.pptx')).toBe(
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  expect(inferArtifactMimeType('model.xlsx')).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  expect(inferArtifactMimeType('preview.png')).toBe('image/png');
});

test('discovers recently created artifact files under the workspace root', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifacts-'),
  );
  try {
    const createdAtMs = Date.now();
    const workbookPath = path.join(tempDir, 'profit-summary.xlsx');
    const sourcePath = path.join(tempDir, 'profit-summary.cjs');
    fs.writeFileSync(workbookPath, 'xlsx payload');
    fs.writeFileSync(sourcePath, 'console.log("helper");');

    const artifacts = discoverArtifactsSince(tempDir, {
      modifiedAfterMs: createdAtMs - 1_000,
    });

    expect(artifacts).toEqual([
      {
        path: workbookPath,
        filename: 'profit-summary.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('keeps only files the turn mentions when given its text', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifacts-'),
  );
  try {
    const createdAtMs = Date.now();
    const deckPath = path.join(tempDir, 'board-deck.pptx');
    fs.writeFileSync(deckPath, 'pptx payload');
    // Written meanwhile by another session sharing the workspace.
    fs.writeFileSync(path.join(tempDir, 'saas-model.xlsx'), 'xlsx payload');

    const artifacts = discoverArtifactsSince(tempDir, {
      modifiedAfterMs: createdAtMs - 1_000,
      mentionedIn: ['Created the deck: [Download](board-deck.pptx)'],
    });

    expect(artifacts.map((artifact) => artifact.path)).toEqual([deckPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('ignores mirrored skill package assets under the workspace skills root', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifacts-'),
  );
  try {
    const createdAtMs = Date.now();
    const skillDir = path.join(tempDir, 'skills', 'blink');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'logo.webp'), 'webp payload');

    const artifacts = discoverArtifactsSince(tempDir, {
      modifiedAfterMs: createdAtMs - 1_000,
    });

    expect(artifacts).toEqual([]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test.each([
  '.cache',
  '.npm',
  '.venv',
  '.venv-plots',
  '__pycache__',
  'node_modules',
])('skips a %s directory anywhere in the workspace', (cacheDirName) => {
  const workspace = makeTempDir();
  const createdAtMs = Date.now();
  const projectChart = writeChart(path.join(workspace, 'project'));
  writeChart(path.join(workspace, 'project', cacheDirName, 'nested'));

  const artifacts = discoverArtifactsSince(workspace, {
    modifiedAfterMs: createdAtMs - 1_000,
    mentionedIn: ['Saved chart.png'],
  });

  expect(artifacts.map((artifact) => artifact.path)).toEqual([projectChart]);
});

test('skips the browser caches but still finds a reply file in the agent HOME', async () => {
  const workspace = makeTempDir();
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspace);
  const { BROWSER_CACHE_DIRS } = await import(
    '../container/src/browser-tools.js'
  );
  const createdAtMs = Date.now();
  for (const cacheDir of BROWSER_CACHE_DIRS) writeChart(cacheDir);
  // HOME in container mode (see src/infra/container-runner.ts).
  const homeChart = writeChart(
    path.join(workspace, '.hybridclaw-runtime', 'home'),
  );

  const artifacts = discoverArtifactsSince(workspace, {
    modifiedAfterMs: createdAtMs - 1_000,
    excludePaths: BROWSER_CACHE_DIRS,
    mentionedIn: ['Saved ~/chart.png'],
  });

  expect(BROWSER_CACHE_DIRS.length).toBeGreaterThan(0);
  expect(artifacts.map((artifact) => artifact.path)).toEqual([homeChart]);
});
