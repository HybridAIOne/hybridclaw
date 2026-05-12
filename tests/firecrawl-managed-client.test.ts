import { afterEach, expect, test, vi } from 'vitest';

import {
  FirecrawlApiError,
  FirecrawlManagedClient,
} from '../src/firecrawl/managed-client.js';

const ORIGINAL_TEST_FIRECRAWL_API_KEY = process.env.TEST_FIRECRAWL_API_KEY;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function jsonResponse(body: unknown, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>) {
  return new FirecrawlManagedClient({
    apiKeyRef: { source: 'env', id: 'TEST_FIRECRAWL_API_KEY' },
    fetch: fetchMock,
    timeoutMs: 1_000,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnvVar('TEST_FIRECRAWL_API_KEY', ORIGINAL_TEST_FIRECRAWL_API_KEY);
});

test('FirecrawlManagedClient sends scrape requests with a secret-backed bearer header', async () => {
  process.env.TEST_FIRECRAWL_API_KEY = 'fc-test-secret';
  const fetchMock = vi.fn(async () =>
    jsonResponse({
      success: true,
      data: {
        markdown: '# Example',
      },
    }),
  );
  const client = makeClient(fetchMock);

  const response = await client.scrape({
    url: 'https://example.com',
    formats: ['markdown'],
  });

  expect(response).toMatchObject({
    success: true,
    data: {
      markdown: '# Example',
    },
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.firecrawl.dev/v2/scrape',
    expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer fc-test-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com',
        formats: ['markdown'],
      }),
    }),
  );
});

test('FirecrawlManagedClient supports crawl lifecycle operations', async () => {
  process.env.TEST_FIRECRAWL_API_KEY = 'fc-test-secret';
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        success: true,
        id: 'crawl_123',
        url: 'https://example.com',
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        status: 'completed',
        total: 2,
        completed: 2,
        data: [{ markdown: 'done' }],
      }),
    )
    .mockResolvedValueOnce(jsonResponse({ status: 'cancelled' }))
    .mockResolvedValueOnce(
      jsonResponse({
        success: true,
        crawls: [{ id: 'crawl_456' }],
      }),
    );
  const client = makeClient(fetchMock);

  await expect(
    client.crawl({ url: 'https://example.com' }),
  ).resolves.toMatchObject({
    id: 'crawl_123',
  });
  await expect(client.getCrawlStatus('crawl_123')).resolves.toMatchObject({
    status: 'completed',
    completed: 2,
  });
  await expect(client.cancelCrawl('crawl_123')).resolves.toEqual({
    status: 'cancelled',
  });
  await expect(client.getActiveCrawls()).resolves.toMatchObject({
    success: true,
    crawls: [{ id: 'crawl_456' }],
  });

  expect(
    fetchMock.mock.calls.map((call) => [call[0], call[1]?.method]),
  ).toEqual([
    ['https://api.firecrawl.dev/v2/crawl', 'POST'],
    ['https://api.firecrawl.dev/v2/crawl/crawl_123', 'GET'],
    ['https://api.firecrawl.dev/v2/crawl/crawl_123', 'DELETE'],
    ['https://api.firecrawl.dev/v2/crawl/active', 'GET'],
  ]);
});

test('FirecrawlManagedClient supports map and extract lifecycle operations', async () => {
  process.env.TEST_FIRECRAWL_API_KEY = 'fc-test-secret';
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        success: true,
        links: [{ url: 'https://example.com/docs' }],
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        success: true,
        id: 'extract_123',
        invalidURLs: [],
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        success: true,
        status: 'completed',
        data: { plans: [] },
        tokensUsed: 12,
      }),
    );
  const client = makeClient(fetchMock);

  await expect(
    client.map({ url: 'https://example.com' }),
  ).resolves.toMatchObject({
    links: [{ url: 'https://example.com/docs' }],
  });
  await expect(
    client.extract({
      urls: ['https://example.com/pricing/*'],
      prompt: 'Extract plan names.',
      schema: { type: 'object' },
    }),
  ).resolves.toMatchObject({
    id: 'extract_123',
  });
  await expect(client.getExtractStatus('extract_123')).resolves.toMatchObject({
    status: 'completed',
    data: { plans: [] },
    tokensUsed: 12,
  });

  expect(
    fetchMock.mock.calls.map((call) => [call[0], call[1]?.method]),
  ).toEqual([
    ['https://api.firecrawl.dev/v2/map', 'POST'],
    ['https://api.firecrawl.dev/v2/extract', 'POST'],
    ['https://api.firecrawl.dev/v2/extract/extract_123', 'GET'],
  ]);
});

test('FirecrawlManagedClient normalizes upstream failures without leaking secrets', async () => {
  process.env.TEST_FIRECRAWL_API_KEY = 'fc-test-secret';
  const fetchMock = vi.fn(async () =>
    jsonResponse(
      {
        error: 'rate limited',
        code: 'RATE_LIMITED',
      },
      429,
      'Too Many Requests',
    ),
  );
  const client = makeClient(fetchMock);

  await expect(
    client.scrape({ url: 'https://example.com' }),
  ).rejects.toMatchObject({
    status: 429,
    statusText: 'Too Many Requests',
    errorCode: 'RATE_LIMITED',
  });
  await expect(
    client.scrape({ url: 'https://example.com' }),
  ).rejects.toBeInstanceOf(FirecrawlApiError);

  try {
    await client.scrape({ url: 'https://example.com' });
  } catch (error) {
    expect(String(error)).not.toContain('fc-test-secret');
  }
});

test('FirecrawlManagedClient rejects unsafe job ids before dispatch', async () => {
  process.env.TEST_FIRECRAWL_API_KEY = 'fc-test-secret';
  const fetchMock = vi.fn(async () => jsonResponse({ status: 'completed' }));
  const client = makeClient(fetchMock);

  await expect(client.getCrawlStatus('../bad')).rejects.toThrow(
    'Firecrawl job id must contain only letters, numbers, "_" or "-".',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
