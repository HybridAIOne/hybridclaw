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

test('mac-cua readiness check refuses provider advertisement until TCC grants are present', async () => {
  const { buildCuaMacResults } = await import(
    '../plugins/mac-cua/src/readiness.js'
  );

  const results = buildCuaMacResults({
    platform: 'darwin',
    driverPath: '/usr/local/bin/cua-driver',
    accessibilityGranted: true,
    screenRecordingGranted: false,
  });

  expect(results).toEqual([
    expect.objectContaining({
      label: 'CUA driver',
      severity: 'ok',
    }),
    expect.objectContaining({
      label: 'macOS permissions',
      severity: 'error',
      message: expect.stringContaining('will not be advertised'),
    }),
  ]);
  expect(results[1]?.message).toContain('Privacy_ScreenCapture');
});

test('mac-cua readiness check reports ready when driver and permissions are available', async () => {
  const { buildCuaMacResults } = await import(
    '../plugins/mac-cua/src/readiness.js'
  );

  const results = buildCuaMacResults({
    platform: 'darwin',
    driverPath: '/usr/local/bin/cua-driver',
    accessibilityGranted: true,
    screenRecordingGranted: true,
  });

  expect(results).toEqual([
    expect.objectContaining({
      label: 'CUA driver',
      severity: 'ok',
    }),
    expect.objectContaining({
      label: 'macOS permissions',
      severity: 'ok',
      message: expect.stringContaining('can be advertised'),
    }),
  ]);
});

test('mac-cua readiness falls back to check_permissions output', async () => {
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
    '../plugins/mac-cua/src/readiness.js'
  );

  const results = buildCuaMacResults({
    platform: 'darwin',
    driverPath,
  });

  expect(results[1]).toEqual(
    expect.objectContaining({
      label: 'macOS permissions',
      severity: 'ok',
      message: expect.stringContaining('can be advertised'),
    }),
  );
});

test('mac-cua readiness does not accept non-executable absolute driver paths', async () => {
  const root = makeTempRoot();
  const driverPath = path.join(root, 'cua-driver');
  fs.writeFileSync(driverPath, '#!/bin/sh\n', { mode: 0o600 });
  const originalDriverBin = process.env.HYBRIDAI_CUA_DRIVER_BIN;
  process.env.HYBRIDAI_CUA_DRIVER_BIN = driverPath;
  try {
    const { resolveCuaDriverPath } = await import(
      '../plugins/mac-cua/src/readiness.js'
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
