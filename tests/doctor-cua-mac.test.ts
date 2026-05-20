import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

let tempRoot = '';

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-cua-doctor-'));
  return tempRoot;
}

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
});

test('cua-mac doctor check refuses provider advertisement until TCC grants are present', async () => {
  const { buildCuaMacResults } = await import(
    '../src/doctor/checks/cua-mac.js'
  );

  const results = buildCuaMacResults({
    platform: 'darwin',
    driverPath: '/usr/local/bin/cua-driver',
    accessibilityGranted: true,
    screenRecordingGranted: false,
  });

  expect(results).toEqual([
    expect.objectContaining({
      category: 'cua-mac',
      label: 'CUA driver',
      severity: 'ok',
    }),
    expect.objectContaining({
      category: 'cua-mac',
      label: 'macOS permissions',
      severity: 'error',
      message: expect.stringContaining('will not be advertised'),
    }),
  ]);
  expect(results[1]?.message).toContain('Privacy_ScreenCapture');
});

test('cua-mac doctor check reports ready when driver and permissions are available', async () => {
  const { buildCuaMacResults } = await import(
    '../src/doctor/checks/cua-mac.js'
  );

  const results = buildCuaMacResults({
    platform: 'darwin',
    driverPath: '/usr/local/bin/cua-driver',
    accessibilityGranted: true,
    screenRecordingGranted: true,
  });

  expect(results).toEqual([
    expect.objectContaining({
      category: 'cua-mac',
      label: 'CUA driver',
      severity: 'ok',
    }),
    expect.objectContaining({
      category: 'cua-mac',
      label: 'macOS permissions',
      severity: 'ok',
      message: expect.stringContaining('can be advertised'),
    }),
  ]);
});

test('cua-mac doctor falls back to check_permissions output', async () => {
  const root = makeTempRoot();
  const driverPath = path.join(root, 'cua-driver');
  fs.writeFileSync(
    driverPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "doctor" ]; then exit 1; fi',
      'if [ "$1" = "check_permissions" ]; then',
      '  printf "✅ Accessibility: granted.\\n✅ Screen Recording: granted.\\n"',
      '  exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  const { buildCuaMacResults } = await import(
    '../src/doctor/checks/cua-mac.js'
  );

  const results = buildCuaMacResults({
    platform: 'darwin',
    driverPath,
  });

  expect(results[1]).toEqual(
    expect.objectContaining({
      category: 'cua-mac',
      label: 'macOS permissions',
      severity: 'ok',
      message: expect.stringContaining('can be advertised'),
    }),
  );
});

test('cua-mac doctor does not accept non-executable absolute driver paths', async () => {
  const root = makeTempRoot();
  const driverPath = path.join(root, 'cua-driver');
  fs.writeFileSync(driverPath, '#!/bin/sh\n', { mode: 0o600 });
  const originalDriverBin = process.env.HYBRIDAI_CUA_DRIVER_BIN;
  process.env.HYBRIDAI_CUA_DRIVER_BIN = driverPath;
  try {
    const { resolveCuaDriverPath } = await import(
      '../src/doctor/checks/cua-mac.js'
    );

    expect(resolveCuaDriverPath()).toBeNull();
  } finally {
    if (originalDriverBin === undefined) {
      delete process.env.HYBRIDAI_CUA_DRIVER_BIN;
    } else {
      process.env.HYBRIDAI_CUA_DRIVER_BIN = originalDriverBin;
    }
  }
});

test('cua-mac doctor component aliases normalize to the dedicated category', async () => {
  const { normalizeComponent } = await import('../src/doctor/utils.js');

  expect(normalizeComponent('cua-mac')).toBe('cua-mac');
  expect(normalizeComponent('mac-cua')).toBe('cua-mac');
  expect(normalizeComponent('cua')).toBe('cua-mac');
});
