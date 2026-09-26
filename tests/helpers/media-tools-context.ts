import fs from 'node:fs';
import path from 'node:path';

import { vi } from 'vitest';

import type { MediaContextItem } from '../../src/types/container.js';

export interface FakeRemoteResult {
  body: Buffer;
  contentType: string;
  contentLength: number;
  url: string;
}

export interface MediaToolsTestContext {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string>;
  providerCredentials: Record<string, Record<string, unknown> | undefined>;
  media: MediaContextItem[];
  workspaceRoot: string;
  workspaceDisplayRoot: string;
  resolveInputPath: (rawPath: string) => Promise<string | null>;
  fetchRemote: ReturnType<
    typeof vi.fn<
      (
        url: string,
        options?: Record<string, unknown>,
      ) => Promise<FakeRemoteResult>
    >
  >;
}

/**
 * Fake runtime context for the media-tools plugin runners: `/workspace/...`
 * maps into `workspaceRoot`, every other path is unreadable, and
 * `fetchRemote` is a mock that fails unless a test stubs it.
 */
export function createMediaToolsContext(
  workspaceRoot: string,
  overrides: Partial<MediaToolsTestContext> = {},
): MediaToolsTestContext {
  return {
    provider: '',
    model: '',
    baseUrl: '',
    apiKey: '',
    requestHeaders: {},
    providerCredentials: {},
    media: [],
    workspaceRoot,
    workspaceDisplayRoot: '/workspace',
    resolveInputPath: async (rawPath) => {
      const prefix = '/workspace/';
      if (!rawPath.startsWith(prefix)) return null;
      const hostPath = path.join(workspaceRoot, rawPath.slice(prefix.length));
      return fs.existsSync(hostPath) ? hostPath : null;
    },
    fetchRemote: vi.fn(async (url: string) => {
      throw new Error(`unexpected fetchRemote ${url}`);
    }),
    ...overrides,
  };
}

export function remoteResult(
  body: Buffer,
  contentType: string,
  url = 'https://example.com/file',
): FakeRemoteResult {
  return { body, contentType, contentLength: body.length, url };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
