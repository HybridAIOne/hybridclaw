import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

let tempRoot = '';

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-doctor-browser-'),
  );
  return tempRoot;
}

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('browser-use doctor check reports installed Playwright Chromium', async () => {
  const root = makeTempRoot();
  const chromiumPath = path.join(root, 'chromium', 'chrome');
  fs.mkdirSync(path.dirname(chromiumPath), { recursive: true });
  fs.writeFileSync(chromiumPath, '', 'utf-8');

  const { buildBrowserUseResults } = await import(
    '../src/doctor/checks/browser-use.js'
  );
  const results = buildBrowserUseResults({
    chromium: {
      executablePath: () => chromiumPath,
    },
  });

  expect(results).toEqual([
    expect.objectContaining({
      category: 'browser-use',
      label: 'Browser use',
      severity: 'ok',
      message: expect.stringContaining('Playwright Chromium installed'),
    }),
  ]);
});

test('browser-use doctor check exposes lazy Chromium install fix when missing', async () => {
  const root = makeTempRoot();
  const chromiumPath = path.join(root, 'missing-chromium', 'chrome');

  const { buildBrowserUseResults } = await import(
    '../src/doctor/checks/browser-use.js'
  );
  const results = buildBrowserUseResults({
    chromium: {
      executablePath: () => chromiumPath,
    },
  });

  expect(results).toEqual([
    expect.objectContaining({
      category: 'browser-use',
      label: 'Browser use',
      severity: 'warn',
      message: expect.stringContaining('Playwright Chromium is not installed'),
      fix: expect.objectContaining({
        summary: 'Install Playwright Chromium (~300 MB)',
      }),
    }),
  ]);
});
