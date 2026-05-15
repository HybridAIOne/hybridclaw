import { expect, test } from 'vitest';

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

test('cua-mac doctor component aliases normalize to the dedicated category', async () => {
  const { normalizeComponent } = await import('../src/doctor/utils.js');

  expect(normalizeComponent('cua-mac')).toBe('cua-mac');
  expect(normalizeComponent('mac-cua')).toBe('cua-mac');
  expect(normalizeComponent('cua')).toBe('cua-mac');
});
