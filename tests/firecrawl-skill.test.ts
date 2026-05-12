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

function runHelper(args: string[]) {
  return spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
  });
}

test('Firecrawl skill manifest declares managed credential and roadmap metadata', () => {
  const skill = fs.readFileSync(skillPath, 'utf-8');
  const manifest = parseSkillManifestFromMarkdown(skill, {
    name: 'firecrawl',
  });

  expect(manifest.credentials).toEqual([
    expect.objectContaining({
      id: 'firecrawl-api-key',
      kind: 'api_key',
      required: true,
      secretRef: {
        source: 'store',
        id: 'FIRECRAWL_API_KEY',
      },
      scope: 'api.firecrawl.dev',
    }),
  ]);
  expect(skill).toContain('related_roadmap:');
  expect(skill).toContain('- R53');
  expect(skill).toContain('- R53.1');
  expect(skill).toContain('issue: 829');
  expect(skill).toContain('sub_issue: 862');
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
  expect(result.stdout).not.toContain('fc-');
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
  expect(JSON.parse(crawlStatus.stdout).httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl/crawl_123',
    method: 'GET',
    bearerSecretName: 'FIRECRAWL_API_KEY',
  });
  expect(JSON.parse(crawlStatus.stdout).httpRequest).not.toHaveProperty('json');
  expect(crawlCancel.status).toBe(0);
  expect(JSON.parse(crawlCancel.stdout).httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl/crawl_123',
    method: 'DELETE',
  });
  expect(activeCrawls.status).toBe(0);
  expect(JSON.parse(activeCrawls.stdout).httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/crawl/active',
    method: 'GET',
  });
  expect(extractStatus.status).toBe(0);
  expect(JSON.parse(extractStatus.stdout).httpRequest).toMatchObject({
    url: 'https://api.firecrawl.dev/v2/extract/extract_123',
    method: 'GET',
  });
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
  const credentialUrl = runHelper([
    'http-request',
    'scrape.url',
    '--url',
    'https://user:pass@example.com',
  ]);

  expect(ignoreRobots.status).not.toBe(0);
  expect(ignoreRobots.stderr).toContain('--ignore-robots-txt');
  expect(tooManyPages.status).not.toBe(0);
  expect(tooManyPages.stderr).toContain('--limit must be between 1 and 10000.');
  expect(credentialUrl.status).not.toBe(0);
  expect(credentialUrl.stderr).toContain(
    '--url must not contain embedded credentials.',
  );
});
