import {
  type SecretHandle,
  withSecretHeader,
} from '../security/secret-handles.js';
import {
  resolveSecretHandleInput,
  type SecretRef,
} from '../security/secret-refs.js';

export const FIRECRAWL_MANAGED_API_BASE_URL = 'https://api.firecrawl.dev/v2';
export const FIRECRAWL_API_KEY_SECRET_NAME = 'FIRECRAWL_API_KEY';

const DEFAULT_API_KEY_REF: SecretRef = {
  source: 'store',
  id: FIRECRAWL_API_KEY_SECRET_NAME,
};
const DEFAULT_TIMEOUT_MS = 120_000;

type FirecrawlFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
};

type FirecrawlFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FirecrawlFetchResponse>;

export interface FirecrawlManagedClientOptions {
  apiKeyRef?: SecretRef;
  baseUrl?: string;
  fetch?: FirecrawlFetch;
  timeoutMs?: number;
  secretAudit?: (handle: SecretHandle, reason: string) => void;
}

export interface FirecrawlScrapeRequest {
  url: string;
  formats?: unknown[];
  [key: string]: unknown;
}

export interface FirecrawlCrawlRequest {
  url: string;
  [key: string]: unknown;
}

export interface FirecrawlMapRequest {
  url: string;
  [key: string]: unknown;
}

export interface FirecrawlExtractRequest {
  urls: string[];
  prompt?: string;
  schema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FirecrawlCrawlStartResponse {
  success: boolean;
  id: string;
  url: string;
  [key: string]: unknown;
}

export interface FirecrawlCrawlStatusResponse {
  status: string;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  expiresAt?: string;
  next?: string | null;
  data?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface FirecrawlCrawlCancelResponse {
  status: 'cancelled';
  [key: string]: unknown;
}

export interface FirecrawlActiveCrawlsResponse {
  success: boolean;
  crawls: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface FirecrawlMapResponse {
  success: boolean;
  links: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface FirecrawlExtractStartResponse {
  success: boolean;
  id: string;
  invalidURLs?: string[] | null;
  [key: string]: unknown;
}

export interface FirecrawlExtractStatusResponse {
  success: boolean;
  data?: Record<string, unknown>;
  status: 'completed' | 'processing' | 'failed' | 'cancelled' | string;
  expiresAt?: string;
  tokensUsed?: number;
  [key: string]: unknown;
}

export class FirecrawlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly bodySnippet: string,
    readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'FirecrawlApiError';
  }
}

function noopSecretAudit(): void {
  // Intentional no-op: callers can inject audit recording when used in a
  // runtime path that has session context.
}

function normalizeBaseUrl(baseUrl?: string): string {
  const input = baseUrl || FIRECRAWL_MANAGED_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Firecrawl baseUrl must be a valid http(s) URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Firecrawl baseUrl must use http or https.');
  }
  return parsed.toString().replace(/\/+$/u, '');
}

function assertRecord(
  payload: unknown,
  operation: string,
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Firecrawl ${operation} returned a non-object response.`);
  }
  return payload as Record<string, unknown>;
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  operation: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Firecrawl ${operation} response is missing "${field}".`);
  }
  return value;
}

function normalizeStartResponse<T extends Record<string, unknown>>(
  payload: unknown,
  operation: string,
  requiredFields: string[],
): T {
  const record = assertRecord(payload, operation);
  if (record.success !== true) {
    throw new Error(`Firecrawl ${operation} response did not report success.`);
  }
  for (const field of requiredFields) {
    requireStringField(record, field, operation);
  }
  return record as T;
}

function parseJsonPayload(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['code', 'errorCode', 'error_code']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

export class FirecrawlManagedClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: FirecrawlManagedClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async scrape(body: FirecrawlScrapeRequest): Promise<FirecrawlScrapeResponse> {
    const payload = await this.requestJson('/scrape', {
      method: 'POST',
      json: body,
    });
    const record = assertRecord(payload, 'scrape');
    if (record.success !== true) {
      throw new Error('Firecrawl scrape response did not report success.');
    }
    return record as unknown as FirecrawlScrapeResponse;
  }

  async crawl(
    body: FirecrawlCrawlRequest,
  ): Promise<FirecrawlCrawlStartResponse> {
    const payload = await this.requestJson('/crawl', {
      method: 'POST',
      json: body,
    });
    return normalizeStartResponse<FirecrawlCrawlStartResponse>(
      payload,
      'crawl',
      ['id', 'url'],
    );
  }

  async getCrawlStatus(id: string): Promise<FirecrawlCrawlStatusResponse> {
    const payload = await this.requestJson(`/crawl/${this.encodeId(id)}`, {
      method: 'GET',
    });
    const record = assertRecord(payload, 'crawl status');
    requireStringField(record, 'status', 'crawl status');
    return record as unknown as FirecrawlCrawlStatusResponse;
  }

  async cancelCrawl(id: string): Promise<FirecrawlCrawlCancelResponse> {
    const payload = await this.requestJson(`/crawl/${this.encodeId(id)}`, {
      method: 'DELETE',
    });
    const record = assertRecord(payload, 'crawl cancel');
    if (record.status !== 'cancelled') {
      throw new Error(
        'Firecrawl crawl cancel response did not report cancelled.',
      );
    }
    return record as unknown as FirecrawlCrawlCancelResponse;
  }

  async getActiveCrawls(): Promise<FirecrawlActiveCrawlsResponse> {
    const payload = await this.requestJson('/crawl/active', {
      method: 'GET',
    });
    const record = normalizeStartResponse<FirecrawlActiveCrawlsResponse>(
      payload,
      'active crawls',
      [],
    );
    if (!Array.isArray(record.crawls)) {
      throw new Error('Firecrawl active crawls response is missing "crawls".');
    }
    return record;
  }

  async map(body: FirecrawlMapRequest): Promise<FirecrawlMapResponse> {
    const payload = await this.requestJson('/map', {
      method: 'POST',
      json: body,
    });
    const record = normalizeStartResponse<FirecrawlMapResponse>(
      payload,
      'map',
      [],
    );
    if (!Array.isArray(record.links)) {
      throw new Error('Firecrawl map response is missing "links".');
    }
    return record;
  }

  async extract(
    body: FirecrawlExtractRequest,
  ): Promise<FirecrawlExtractStartResponse> {
    const payload = await this.requestJson('/extract', {
      method: 'POST',
      json: body,
    });
    return normalizeStartResponse<FirecrawlExtractStartResponse>(
      payload,
      'extract',
      ['id'],
    );
  }

  async getExtractStatus(id: string): Promise<FirecrawlExtractStatusResponse> {
    const payload = await this.requestJson(`/extract/${this.encodeId(id)}`, {
      method: 'GET',
    });
    const record = normalizeStartResponse<FirecrawlExtractStatusResponse>(
      payload,
      'extract status',
      ['status'],
    );
    return record;
  }

  private resolveApiKeyHandle(): SecretHandle {
    const handle = resolveSecretHandleInput(
      this.options.apiKeyRef || DEFAULT_API_KEY_REF,
      {
        path: 'FirecrawlManagedClient.apiKeyRef',
        required: true,
        sinkKind: 'http',
      },
    );
    if (!handle) {
      throw new Error('Firecrawl API key did not resolve.');
    }
    return handle;
  }

  private encodeId(id: string): string {
    const normalized = id.trim();
    if (!normalized || !isSafeId(normalized)) {
      throw new Error(
        'Firecrawl job id must contain only letters, numbers, "_" or "-".',
      );
    }
    return encodeURIComponent(normalized);
  }

  private async requestJson(
    path: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; json?: unknown },
  ): Promise<unknown> {
    const apiKey = this.resolveApiKeyHandle();
    const auth = withSecretHeader(apiKey, 'Authorization', {
      prefix: 'Bearer',
      audit: this.options.secretAudit || noopSecretAudit,
    });
    const requestFetch = this.options.fetch || fetch;
    const headers: Record<string, string> = {
      [auth.name]: auth.value,
    };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }

    const response = await requestFetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const payload = parseJsonPayload(text);
    if (!response.ok) {
      const code = extractErrorCode(payload);
      const snippet = text.slice(0, 500);
      throw new FirecrawlApiError(
        `Firecrawl API ${init.method} ${path} failed with HTTP ${response.status} ${response.statusText}: ${snippet}`,
        response.status,
        response.statusText,
        snippet,
        code,
      );
    }
    return payload;
  }
}
