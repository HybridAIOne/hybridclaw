import { afterEach, describe, expect, test, vi } from 'vitest';

const sentryInit = vi.fn(() => ({}));
const sentrySetTag = vi.fn();
const sentryCaptureException = vi.fn();
const sentryFlush = vi.fn(async () => true);

async function importFreshSentry() {
  vi.resetModules();
  vi.doMock('@sentry/node', () => ({
    captureException: sentryCaptureException,
    flush: sentryFlush,
    init: sentryInit,
    setTag: sentrySetTag,
  }));
  return import('../src/observability/sentry.ts');
}

describe('Sentry observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@sentry/node');
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    sentryInit.mockClear();
    sentrySetTag.mockClear();
    sentryCaptureException.mockClear();
    sentryFlush.mockClear();
  });

  test('stays no-op when SENTRY_DSN is unset', async () => {
    const { captureSentryException, initSentry, shutdownSentry } =
      await importFreshSentry();

    await initSentry();
    captureSentryException(new Error('ignored'), { mechanism: 'test' });
    await shutdownSentry();

    expect(sentryInit).not.toHaveBeenCalled();
    expect(sentryCaptureException).not.toHaveBeenCalled();
    expect(sentryFlush).not.toHaveBeenCalled();
  });

  test('initializes from Sentry environment variables', async () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    process.env.SENTRY_ENVIRONMENT = 'production';
    process.env.SENTRY_RELEASE = 'hybridclaw@1.2.3';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.25';
    const { initSentry } = await importFreshSentry();

    await initSentry();

    expect(sentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://public@example.com/1',
        environment: 'production',
        release: 'hybridclaw@1.2.3',
        skipOpenTelemetrySetup: true,
        tracesSampleRate: 0.25,
      }),
    );
    expect(sentrySetTag).toHaveBeenCalledWith(
      'service',
      'hybridclaw-gateway',
    );
  });

  test('redacts likely secrets before sending events and extra context', async () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { captureSentryException, initSentry } = await importFreshSentry();

    await initSentry();
    const options = sentryInit.mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
    };
    const event = options.beforeSend({
      request: {
        url: 'https://example.com/callback?access_token=secret-token',
      },
    });

    captureSentryException(new Error('boom'), {
      mechanism: 'test.capture',
      extra: { apiKey: 'sk-test-secret' },
      tags: { area: 'unit' },
    });

    expect(JSON.stringify(event)).not.toContain('secret-token');
    expect(sentryCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: { apiKey: expect.not.stringContaining('sk-test-secret') },
      tags: {
        area: 'unit',
        mechanism: 'test.capture',
      },
    });
  });

  test('keeps mechanism tag authoritative over caller tags', async () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { captureSentryException, initSentry } = await importFreshSentry();

    await initSentry();
    captureSentryException(new Error('boom'), {
      mechanism: 'authoritative',
      tags: { mechanism: 'caller-value' },
    });

    expect(sentryCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: undefined,
      tags: {
        mechanism: 'authoritative',
      },
    });
  });

  test('flushes initialized Sentry client during shutdown', async () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { initSentry, shutdownSentry } = await importFreshSentry();

    await initSentry();
    await shutdownSentry(123);
    await shutdownSentry(123);

    expect(sentryFlush).toHaveBeenCalledTimes(1);
    expect(sentryFlush).toHaveBeenCalledWith(123);
  });

  test('swallows Sentry flush failures during shutdown', async () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sentryFlush.mockRejectedValueOnce(new Error('flush failed'));
    const { initSentry, shutdownSentry } = await importFreshSentry();

    await initSentry();
    await expect(shutdownSentry(123)).resolves.toBeUndefined();

    expect(sentryFlush).toHaveBeenCalledWith(123);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to flush Sentry SDK:',
      expect.any(Error),
    );
  });
});
