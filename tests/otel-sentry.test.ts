import { afterEach, describe, expect, test, vi } from 'vitest';

const captureSentryException = vi.fn();

async function importFreshOtel() {
  vi.resetModules();
  vi.doMock('../src/observability/sentry.js', () => ({
    captureSentryException,
  }));
  return import('../src/observability/otel.ts');
}

describe('OpenTelemetry Sentry bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/observability/sentry.js');
    captureSentryException.mockClear();
  });

  test('adds gateway span identity tags to captured async errors', async () => {
    const error = new Error('span failed');
    const { withSpan } = await importFreshOtel();

    await expect(
      withSpan(
        'hybridclaw.gateway.handle_message',
        {
          'hybridclaw.agent_id': 'main',
          'hybridclaw.channel_id': 'tui',
          'hybridclaw.session_id': 'main:tui:dm:test',
          'hybridclaw.model': 'hybridai/example',
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toThrow(error);

    expect(captureSentryException).toHaveBeenCalledWith(error, {
      mechanism: 'otel.span',
      tags: {
        agent_id: 'main',
        channel_id: 'tui',
        session_id: 'main:tui:dm:test',
        span: 'hybridclaw.gateway.handle_message',
      },
      extra: {
        attributes: {
          'hybridclaw.agent_id': 'main',
          'hybridclaw.channel_id': 'tui',
          'hybridclaw.session_id': 'main:tui:dm:test',
          'hybridclaw.model': 'hybridai/example',
        },
      },
    });
  });

  test('omits missing span identity tags from captured sync errors', async () => {
    const error = new Error('skill load failed');
    const { withSpanSync } = await importFreshOtel();

    expect(() =>
      withSpanSync(
        'hybridclaw.skills.load',
        {
          'hybridclaw.agent_id': 'main',
          'hybridclaw.channel_id': '',
        },
        () => {
          throw error;
        },
      ),
    ).toThrow(error);

    expect(captureSentryException).toHaveBeenCalledWith(error, {
      mechanism: 'otel.span',
      tags: {
        agent_id: 'main',
        span: 'hybridclaw.skills.load',
      },
      extra: {
        attributes: {
          'hybridclaw.agent_id': 'main',
          'hybridclaw.channel_id': '',
        },
      },
    });
  });
});
