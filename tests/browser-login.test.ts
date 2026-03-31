import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node:child_process');
});

test('launchBrowserLogin includes automation-compatible profile flags', async () => {
  const spawn = vi.fn(() => ({}) as never);
  const spawnSync = vi.fn(() => ({
    status: 0,
    stdout: '/usr/bin/google-chrome\n',
  }));

  vi.doMock('node:child_process', () => ({
    spawn,
    spawnSync,
  }));

  const { launchBrowserLogin } = await import(
    '../src/browser/browser-login.js'
  );

  await launchBrowserLogin('/tmp/hybridclaw-browser-profile', {
    url: 'https://www.linkedin.com/notifications/',
  });

  expect(spawn).toHaveBeenCalledTimes(1);
  const [browserPath, args, options] = spawn.mock.calls[0] ?? [];
  expect(browserPath).toEqual(expect.any(String));
  expect(args).toEqual(
    expect.arrayContaining([
      '--password-store=basic',
      '--use-mock-keychain',
      '--user-data-dir=/tmp/hybridclaw-browser-profile',
      'https://www.linkedin.com/notifications/',
    ]),
  );
  expect(options).toEqual(
    expect.objectContaining({
      detached: false,
      stdio: 'ignore',
    }),
  );
});
