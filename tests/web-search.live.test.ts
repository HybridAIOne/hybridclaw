import { expect, test } from 'vitest';

import { searchWeb } from '../container/src/web-search.js';

const RUN_LIVE = process.env.HYBRIDCLAW_RUN_LIVE_WEB_SEARCH === '1';
const liveTest = RUN_LIVE ? test : test.skip;
const braveTest =
  RUN_LIVE && process.env.BRAVE_API_KEY ? test : test.skip;

liveTest(
  'duckduckgo live search returns results',
  async () => {
    const result = await searchWeb({
      query: 'OpenAI API documentation',
      count: 2,
      provider: 'duckduckgo',
    });

    expect(result.provider).toBe('duckduckgo');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.url).toMatch(/^https?:\/\//);
  },
  30_000,
);

braveTest(
  'brave live search returns results when BRAVE_API_KEY is configured',
  async () => {
    const result = await searchWeb({
      query: 'OpenAI API documentation',
      count: 2,
      provider: 'brave',
    });

    expect(result.provider).toBe('brave');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.url).toMatch(/^https?:\/\//);
  },
  30_000,
);
