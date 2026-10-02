import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), readSecret: vi.fn() }));
vi.mock('../src/security/public-https-fetch.js', () => ({
  fetchPublicHttpsBuffer: mocks.fetch,
}));
vi.mock('../src/security/runtime-secrets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readStoredRuntimeSecret: mocks.readSecret,
}));

const { deliverScheduledWebhook, SCHEDULER_WEBHOOK_SECRET_NAME } = await import(
  '../src/gateway/scheduled-webhook-delivery.js'
);
const { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } = await import(
  '../src/a2a/webhook-outbound.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({ body: Buffer.alloc(0) });
});

describe('deliverScheduledWebhook', () => {
  test('posts through the SSRF guard with a body signature the receiver can verify', async () => {
    mocks.readSecret.mockReturnValue('test-secret');

    await deliverScheduledWebhook(
      'https://hooks.example.com/job',
      'done',
      'schedule-job:a',
    );

    expect(mocks.readSecret).toHaveBeenCalledWith(SCHEDULER_WEBHOOK_SECRET_NAME);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/job');
    expect(options.method).toBe('POST');
    expect(
      verifyWebhookSignature({
        header: options.headers[WEBHOOK_SIGNATURE_HEADER],
        body: options.body,
        secret: 'test-secret',
      }),
    ).toBe(true);
  });

  test('refuses to deliver unsigned when no signing secret is stored', async () => {
    mocks.readSecret.mockReturnValue(null);

    await expect(
      deliverScheduledWebhook('https://hooks.example.com/job', 'done', 'x'),
    ).rejects.toThrow(SCHEDULER_WEBHOOK_SECRET_NAME);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
