import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { parseSkillManifestFromMarkdown } from '../src/skills/skill-manifest.js';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'firecrawl',
  'firecrawl.cjs',
);
const skillPath = path.join(process.cwd(), 'skills', 'firecrawl', 'SKILL.md');

function runHelper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

test('Firecrawl skill manifest declares managed credential and roadmap metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'firecrawl',
  });

  expect(manifest.credentials).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'firecrawl-api-key',
        kind: 'api_key',
        required: false,
        secretRef: {
          source: 'store',
          id: 'FIRECRAWL_API_KEY',
        },
        scope: 'api.firecrawl.dev',
      }),
      expect.objectContaining({
        id: 'firecrawl-self-host-api-key',
        kind: 'api_key',
        required: false,
        secretRef: {
          source: 'store',
          id: 'FIRECRAWL_SELF_HOST_API_KEY',
        },
        scope: 'self-hosted Firecrawl',
      }),
    ]),
  );
  expect(skill).toContain('related_roadmap:');
  expect(skill).toContain('- R53');
  expect(skill).toContain('- R53.1');
  expect(skill).toContain('- R53.2');
  expect(skill).toContain('issue: 829');
  expect(skill).toContain('sub_issues:');
  expect(skill).toContain('- 862');
  expect(skill).toContain('- 863');
  expect(skill).toContain('scrape.url');
  expect(skill).toContain('crawl.site');
  expect(skill).toContain('crawl.status');
  expect(skill).toContain('extract.structured');
  expect(skill).toContain('extract.status');
});

test('Firecrawl helper --help exits cleanly', () => {
  const result = runHelper(['--help']);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Firecrawl skill helper');
  expect(result.stdout).toContain('--adapter managed|self-host');
  expect(result.stdout).toContain('scrape.url');
  expect(result.stdout).toContain('crawl.site');
  expect(result.stdout).toContain('crawl.status');
  expect(result.stdout).toContain('map.site');
  expect(result.stdout).toContain('extract.structured');
  expect(result.stdout).toContain('extract.status');
});

test('Firecrawl helper emits gateway-proxied scrape requests without secrets', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'scrape.url',
    '--url',
    'https://example.com/docs',
    '--format-name',
    'markdown',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'http-request',
    adapter: 'firecrawl-managed',
    operation: 'scrape.url',
    httpRequest: {
      url: 'https://api.firecrawl.dev/v2/scrape',
      method: 'POST',
      bearerSecretName: 'FIRECRAWL_API_KEY',
      skillName: 'firecrawl',
      json: {
        url: 'https://example.com/docs',
        formats: ['markdown'],
        onlyMainContent: true,
      },
    },
  });
  expect(payload).not.toHaveProperty('credential');
  expect(payload.costMeasurement).toEqual({
    system: 'UsageTotals',
    subLimitKey: 'firecrawl',
  });
  expect(result.stdout).not.toContain('fc-');
});

test('Firecrawl helper emits self-host requests with the same operation surface', () => {
  const result = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002',
    '--self-host-auth',
    'http-request',
    'scrape.url',
    '--url',
    'https://example.com/docs',
    '--format-name',
    'markdown',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    command: 'http-request',
    adapter: 'firecrawl-self-host',
    operation: 'scrape.url',
    httpRequest: {
      url: 'http://firecrawl:3002/v2/scrape',
      method: 'POST',
      bearerSecretName: 'FIRECRAWL_SELF_HOST_API_KEY',
      skillName: 'firecrawl',
      json: {
        url: 'https://example.com/docs',
        formats: ['markdown'],
        onlyMainContent: true,
      },
    },
  });
  expect(payload).not.toHaveProperty('costMeasurement');
  expect(result.stdout).not.toContain('fc-');
});

test('Firecrawl helper reads the self-host base URL from the environment', () => {
  const result = runHelper(
    [
      '--format',
      'json',
      '--adapter',
      'self-host',
      'http-request',
      'map.site',
      '--url',
      'https://example.com',
    ],
    {
      FIRECRAWL_SELF_HOST_BASE_URL: 'https://firecrawl.example/internal',
    },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://firecrawl.example/internal/v2/map',
    method: 'POST',
  });
  expect(payload.httpRequest).not.toHaveProperty('bearerSecretName');
  expect(payload).not.toHaveProperty('costMeasurement');
});

test('Firecrawl helper warns when self-host auth secret is set but not enabled', () => {
  const result = runHelper(
    [
      '--format',
      'json',
      '--adapter',
      'self-host',
      '--base-url',
      'http://firecrawl:3002',
      'http-request',
      'scrape.url',
      '--url',
      'https://example.com/docs',
    ],
    {
      FIRECRAWL_SELF_HOST_API_KEY: 'test-key',
    },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).not.toHaveProperty('bearerSecretName');
  expect(result.stderr).toContain(
    'Warning: FIRECRAWL_SELF_HOST_API_KEY is set but --self-host-auth was not passed; the secret will not be injected.',
  );
  expect(result.stdout).not.toContain('test-key');
});

test('Firecrawl helper keeps crawl and extract interfaces available in self-host mode', () => {
  const crawl = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002/v2',
    'http-request',
    'crawl.site',
    '--url',
    'https://example.com/docs',
    '--limit',
    '10',
  ]);
  const extract = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002',
    'http-request',
    'extract.structured',
    '--url',
    'https://example.com/pricing/*',
    '--schema-json',
    '{"type":"object","properties":{"plans":{"type":"array"}}}',
  ]);
  const crawlStatus = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002',
    'http-request',
    'crawl.status',
    '--id',
    'crawl_123',
  ]);
  const crawlCancel = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002',
    'http-request',
    'crawl.cancel',
    '--id',
    'crawl_123',
  ]);
  const activeCrawls = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002',
    'http-request',
    'crawl.active',
  ]);
  const extractStatus = runHelper([
    '--format',
    'json',
    '--adapter',
    'self-host',
    '--base-url',
    'http://firecrawl:3002',
    'http-request',
    'extract.status',
    '--id',
    'extract_123',
  ]);

  expect(crawl.status).toBe(0);
  expect(JSON.parse(crawl.stdout).httpRequest).toMatchObject({
    url: 'http://firecrawl:3002/v2/crawl',
    method: 'POST',
    json: {
      url: 'https://example.com/docs',
      limit: 10,
      ignoreRobotsTxt: false,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    },
  });
  expect(extract.status).toBe(0);
  expect(JSON.parse(extract.stdout).httpRequest).toMatchObject({
    url: 'http://firecrawl:3002/v2/extract',
    method: 'POST',
    json: {
      urls: ['https://example.com/pricing/*'],
      ignoreInvalidURLs: true,
    },
  });
  expect(crawlStatus.status).toBe(0);
  expect(JSON.parse(crawlStatus.stdout).httpRequest).toMatchObject({
    url: 'http://firecrawl:3002/v2/crawl/crawl_123',
    method: 'GET',
  });
  expect(crawlCancel.status).toBe(0);
  expect(JSON.parse(crawlCancel.stdout).httpRequest).toMatchObject({
    url: 'http://firecrawl:3002/v2/crawl/crawl_123',
    method: 'DELETE',
  });
  expect(activeCrawls.status).toBe(0);
  expect(JSON.parse(activeCrawls.stdout).httpRequest).toMatchObject({
    url: 'http://firecrawl:3002/v2/crawl/active',
    method: 'GET',
  });
  expect(extractStatus.status).toBe(0);
  expect(JSON.parse(extractStatus.stdout).httpRequest).toMatchObject({
    url: 'http://firecrawl:3002/v2/extract/extract_123',
    method: 'GET',
  });
});

test('Firecrawl helper normalizes short operation aliases', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'map',
    '--url',
    'https://example.com',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.operation).toBe('map.site');
  expect(payload.httpRequest.url).toBe('https://api.firecrawl.dev/v2/map');
});

test('Firecrawl helper emits conservative crawl requests and respects robots.txt', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'crawl.site',
    '--url',
    'https://example.com/docs',
    '--include-path',
    'docs/.*',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl',
    method: 'POST',
    bearerSecretName: 'FIRECRAWL_API_KEY',
    json: {
      url: 'https://example.com/docs',
      limit: 25,
      ignoreRobotsTxt: false,
      includePaths: ['docs/.*'],
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    },
  });
});

test('Firecrawl helper maps sites with bounded default limits', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'map.site',
    '--url',
    'https://example.com',
    '--search',
    'docs',
    '--sitemap',
    'include',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/map',
    method: 'POST',
    bearerSecretName: 'FIRECRAWL_API_KEY',
    json: {
      url: 'https://example.com/',
      limit: 500,
      search: 'docs',
      sitemap: 'include',
    },
  });
});

test('Firecrawl helper implements structured extraction through v2 extract endpoint', () => {
  const result = runHelper([
    '--format',
    'json',
    'http-request',
    'extract.structured',
    '--url',
    'https://example.com/pricing/*',
    '--schema-json',
    '{"type":"object","properties":{"plans":{"type":"array"}}}',
    '--prompt',
    'Extract plan names and prices.',
  ]);

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/extract',
    method: 'POST',
    bearerSecretName: 'FIRECRAWL_API_KEY',
    json: {
      urls: ['https://example.com/pricing/*'],
      ignoreInvalidURLs: true,
      schema: {
        type: 'object',
        properties: {
          plans: {
            type: 'array',
          },
        },
      },
      prompt: 'Extract plan names and prices.',
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    },
  });
});

test('Firecrawl helper emits crawl and extract lifecycle requests', () => {
  const crawlStatus = runHelper([
    '--format',
    'json',
    'http-request',
    'crawl.status',
    '--id',
    'crawl_123',
  ]);
  const crawlCancel = runHelper([
    '--format',
    'json',
    'http-request',
    'crawl.cancel',
    '--id',
    'crawl_123',
  ]);
  const activeCrawls = runHelper([
    '--format',
    'json',
    'http-request',
    'crawl.active',
  ]);
  const extractStatus = runHelper([
    '--format',
    'json',
    'http-request',
    'extract.status',
    '--id',
    'extract_123',
  ]);

  expect(crawlStatus.status).toBe(0);
  const crawlStatusPayload = JSON.parse(crawlStatus.stdout);
  expect(crawlStatusPayload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl/crawl_123',
    method: 'GET',
    bearerSecretName: 'FIRECRAWL_API_KEY',
  });
  expect(crawlStatusPayload.httpRequest).not.toHaveProperty('json');
  expect(crawlStatusPayload).not.toHaveProperty('costMeasurement');
  expect(crawlCancel.status).toBe(0);
  const crawlCancelPayload = JSON.parse(crawlCancel.stdout);
  expect(crawlCancelPayload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl/crawl_123',
    method: 'DELETE',
  });
  expect(crawlCancelPayload).not.toHaveProperty('costMeasurement');
  expect(activeCrawls.status).toBe(0);
  const activeCrawlsPayload = JSON.parse(activeCrawls.stdout);
  expect(activeCrawlsPayload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl/active',
    method: 'GET',
  });
  expect(activeCrawlsPayload).not.toHaveProperty('costMeasurement');
  expect(extractStatus.status).toBe(0);
  const extractStatusPayload = JSON.parse(extractStatus.stdout);
  expect(extractStatusPayload.httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/extract/extract_123',
    method: 'GET',
  });
  expect(extractStatusPayload).not.toHaveProperty('costMeasurement');
});

test('Firecrawl helper rejects unsafe or oversized crawl requests', () => {
  const ignoreRobots = runHelper([
    'http-request',
    'crawl.site',
    '--url',
    'https://example.com',
    '--ignore-robots-txt',
  ]);
  const tooManyPages = runHelper([
    'http-request',
    'crawl.site',
    '--url',
    'https://example.com',
    '--limit',
    '10001',
  ]);
  const oversizedMapLimit = runHelper([
    'http-request',
    'map.site',
    '--url',
    'https://example.com',
    '--limit',
    '100001',
  ]);
  const credentialUrl = runHelper([
    'http-request',
    'scrape.url',
    '--url',
    'https://user:pass@example.com',
  ]);
  const customBaseUrl = runHelper([
    'http-request',
    'scrape.url',
    '--base-url',
    'https://attacker.example',
    '--url',
    'https://example.com',
  ]);
  const selfHostMissingBaseUrl = runHelper(
    [
      '--adapter',
      'self-host',
      'http-request',
      'scrape.url',
      '--url',
      'https://example.com',
    ],
    { FIRECRAWL_SELF_HOST_BASE_URL: '' },
  );
  const credentialBaseUrl = runHelper([
    '--adapter',
    'self-host',
    '--base-url',
    'https://user:pass@firecrawl.example',
    'http-request',
    'scrape.url',
    '--url',
    'https://example.com',
  ]);
  const emptyAdapter = runHelper([
    '--adapter',
    '',
    'http-request',
    'scrape.url',
    '--url',
    'https://example.com',
  ]);

  expect(ignoreRobots.status).not.toBe(0);
  expect(ignoreRobots.stderr).toContain('--ignore-robots-txt');
  expect(tooManyPages.status).not.toBe(0);
  expect(tooManyPages.stderr).toContain('--limit must be between 1 and 10000.');
  expect(oversizedMapLimit.status).not.toBe(0);
  expect(oversizedMapLimit.stderr).toContain(
    '--limit must be between 1 and 100000.',
  );
  expect(credentialUrl.status).not.toBe(0);
  expect(credentialUrl.stderr).toContain(
    '--url must not contain embedded credentials.',
  );
  expect(customBaseUrl.status).not.toBe(0);
  expect(customBaseUrl.stderr).toContain(
    '--base-url is only supported with --adapter self-host.',
  );
  expect(selfHostMissingBaseUrl.status).not.toBe(0);
  expect(selfHostMissingBaseUrl.stderr).toContain(
    'Self-host mode requires --base-url or FIRECRAWL_SELF_HOST_BASE_URL.',
  );
  expect(credentialBaseUrl.status).not.toBe(0);
  expect(credentialBaseUrl.stderr).toContain(
    '--base-url must not contain embedded credentials.',
  );
  expect(emptyAdapter.status).not.toBe(0);
  expect(emptyAdapter.stderr).toContain('--adapter requires a value.');
});
