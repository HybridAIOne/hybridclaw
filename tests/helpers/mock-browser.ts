import { Buffer } from 'node:buffer';

import { vi } from 'vitest';

export function createMockBrowserPage(options?: {
  screenshot?: string;
  url?: string;
}) {
  return {
    evaluate: vi.fn(async (fn: () => unknown) => await fn()),
    screenshot: vi.fn(async () =>
      Buffer.from(options?.screenshot || 'mock-png'),
    ),
    goto: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    url: vi.fn(() => options?.url || 'https://login.datev.de/login'),
    mouse: { wheel: vi.fn(async () => undefined) },
    waitForSelector: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      fill: vi.fn(async () => undefined),
      pressSequentially: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => undefined),
    })),
  };
}

export function createMockBrowserContext(page = createMockBrowserPage()) {
  return {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
}
