import { afterEach, expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-second-opinion-',
});
const TEST_ACTOR = {
  userId: 'test-user',
  username: 'tester',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/providers/auxiliary.js');
  vi.doUnmock('../src/providers/model-catalog.js');
  vi.doUnmock('../src/commands/second-opinion-web-search.js');
});

async function loadGatewayFixture() {
  const { initDatabase } = await import('../src/memory/db.ts');
  const { memoryService } = await import('../src/memory/memory-service.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  return { memoryService, handleGatewayCommand };
}

function mockModelCatalog(
  models: string[],
  metadataOverrides: Record<
    string,
    {
      contextWindow?: number | null;
      pricingUsdPerToken?: { input: number | null; output: number | null };
    }
  > = {},
) {
  const refreshAvailableModelCatalogs = vi.fn(async () => ({
    attempted: 1,
    fulfilled: 1,
    rejected: 0,
    discoveredModelCount: models.length,
    failures: [],
  }));
  vi.doMock('../src/providers/model-catalog.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/model-catalog.js')
    >('../src/providers/model-catalog.js');
    return {
      ...actual,
      refreshAvailableModelCatalogs,
      getAvailableModelList: vi.fn((provider?: string) =>
        !provider || provider === 'codex' || provider === 'openai-codex'
          ? models
          : [],
      ),
      getModelCatalogMetadata: vi.fn((model: string) => {
        const metadata = actual.getModelCatalogMetadata(model);
        const override = metadataOverrides[model];
        if (!override) return metadata;
        return {
          ...metadata,
          ...override,
          pricingUsdPerToken:
            override.pricingUsdPerToken ?? metadata.pricingUsdPerToken,
        };
      }),
    };
  });
  return { refreshAvailableModelCatalogs };
}

function seedSession(
  memoryService: typeof import('../src/memory/memory-service.ts').memoryService,
  sessionId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  const session = memoryService.getOrCreateSession(
    sessionId,
    null,
    'web',
    undefined,
  );
  for (const message of messages) {
    memoryService.storeMessage({
      sessionId: session.id,
      ...TEST_ACTOR,
      ...message,
    });
  }
  return session;
}

test('second-opinion parser rejects invalid flags and supports no-transcript', async () => {
  setupHome();
  const { parseSecondOpinionArgs } = await import(
    '../src/commands/second-opinion-command.ts'
  );

  expect(
    parseSecondOpinionArgs([
      '--no-transcript',
      '--max-context',
      '99',
      'Is this safe?',
    ]),
  ).toMatchObject({
    mode: 'compare',
    question: 'Is this safe?',
    includeTranscript: false,
    maxContextMessages: 32,
  });
  expect(parseSecondOpinionArgs(['compare'])).toMatchObject({
    mode: 'compare',
    question: '',
  });
  expect(
    parseSecondOpinionArgs(['validate', 'openai-codex/gpt-5.5']),
  ).toMatchObject({
    mode: 'validate',
    model: 'openai-codex/gpt-5.5',
    question: '',
  });
  expect(
    parseSecondOpinionArgs(['validate', '--model', 'openai-codex/gpt-5.5']),
  ).toMatchObject({
    mode: 'validate',
    model: 'openai-codex/gpt-5.5',
    question: '',
  });
  expect(parseSecondOpinionArgs(['validate', 'model-a', 'extra'])).toMatchObject(
    {
      error:
        'Unexpected second-opinion validate argument: extra. Use `--model <model>` or pass a single model name after `validate`.',
    },
  );
  expect(parseSecondOpinionArgs(['fact-check', 'openai-codex/gpt-5.5'])).toMatchObject({
    mode: 'validate',
    model: 'openai-codex/gpt-5.5',
    useWebSearch: true,
    question: '',
  });
  expect(parseSecondOpinionArgs(['--web-search'])).toMatchObject({
    mode: 'validate',
    useWebSearch: true,
    question: '',
  });
  expect(parseSecondOpinionArgs(['--mode', 'bogus'])).toMatchObject({
    error: 'Unknown second-opinion option: --mode.',
  });
  expect(parseSecondOpinionArgs(['validate-last'])).toMatchObject({
    mode: 'compare',
    question: 'validate-last',
  });
  expect(parseSecondOpinionArgs(['--unknown'])).toMatchObject({
    error: 'Unknown second-opinion option: --unknown.',
  });
});

test('second-opinion verdict parser validates typed critique output', async () => {
  setupHome();
  const { parseSecondOpinionVerdict } = await import(
    '../src/commands/second-opinion-command.ts'
  );

  expect(
    parseSecondOpinionVerdict(
      '{"revised_answer":"Ship it.","confidence":"certain","material_disagreements":["none"],"missing_caveats":["watch logs"]}',
    ),
  ).toMatchObject({
    revisedAnswer: 'Ship it.',
    confidence: 'medium',
    materialDisagreements: ['none'],
    missingCaveats: ['watch logs'],
  });
  expect(() => parseSecondOpinionVerdict('not json')).toThrow(
    'second_opinion response was not JSON.',
  );
  expect(() => parseSecondOpinionVerdict('{"verdict":"ok"}')).toThrow(
    'missing `revised_answer`',
  );
});

test('second-opinion validate-last sends the previous answer to a stronger tool-less model call', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/gpt-5.5',
    content: JSON.stringify({
      verdict: 'The draft missed one caveat.',
      revised_answer: 'Use the migration plan, but verify backups first.',
      material_disagreements: ['Backup validation was missing.'],
      missing_caveats: ['Run a restore smoke test before deleting old data.'],
      confidence: 'high',
    }),
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0 },
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion', [
    {
      role: 'user',
      content: 'How should we migrate the database?',
    },
    {
      role: 'assistant',
      content: 'Move rows into the new table and delete the old one.',
    },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') throw new Error('Expected info result.');
  expect(result.title).toBe('Second Opinion');
  expect(result.text).toContain('verify backups first');
  expect(result.text).toContain('Backup validation was missing.');

  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(1);
  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  expect(call?.task).toBe('second_opinion');
  expect(call?.tools).toEqual([]);
  expect(call?.provider).toBe('openai-codex');
  expect(call?.model).toBe('openai-codex/gpt-5.5');
  expect(call?.allowFallback).toBe(false);
  expect(call?.temperature).toBe(0);
  const payload = JSON.parse(String(call?.messages?.[1]?.content));
  expect(payload.mode).toBe('validate');
  expect(payload.original_question).toBe('How should we migrate the database?');
  expect(payload.active_assistant_draft).toContain('delete the old one');

  const { getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const completed = getRecentStructuredAuditForSession(session.id, 10).find(
    (entry) => entry.event_type === 'second_opinion.completed',
  );
  expect(JSON.parse(completed?.payload || '{}')).toMatchObject({
    materialDisagreements: 1,
    questionTruncated: false,
    synthesisOutcome: 'accepted',
    modelMetadataCheck: {
      requestedMaxOutputTokens: 1200,
      estimatedInputTokens: expect.any(Number),
      estimatedTotalTokens: expect.any(Number),
    },
    usage: { totalTokens: 30 },
  });
});

test('second-opinion fact-check adds web search and fetch evidence to validation', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const runSecondOpinionWebSearchMock = vi.fn(async () => ({
    provider: 'tavily' as const,
    queries: [
      'age of universe latest cosmology measurements',
      'Planck cosmic microwave background age universe',
    ],
    results: Array.from({ length: 10 }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.com/source-${index + 1}`,
      snippet: `Snippet ${index + 1}`,
      fetchedExcerpt: `Fetched source excerpt ${index + 1}`,
    })),
    rendered: 'web evidence',
  }));
  vi.doMock('../src/commands/second-opinion-web-search.js', () => ({
    runSecondOpinionWebSearch: runSecondOpinionWebSearchMock,
  }));

  const callAuxiliaryModelMock = vi.fn(async (params: { messages: Array<{ content: string }> }) => {
    if (params.messages[0]?.content.includes('web search queries')) {
      return {
        provider: 'openai-codex' as const,
        model: 'openai-codex/gpt-5.5',
        content: JSON.stringify({
          queries: [
            'age of universe latest cosmology measurements',
            'Planck cosmic microwave background age universe',
          ],
        }),
      };
    }
    return {
      provider: 'openai-codex' as const,
      model: 'openai-codex/gpt-5.5',
      content: JSON.stringify({
        verdict: 'The age is accurate.',
        revised_answer:
          'The universe is about 13.8 billion years old, based on modern cosmological measurements.',
        material_disagreements: [],
        missing_caveats: ['The value depends slightly on the cosmological model.'],
        confidence: 'high',
      }),
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0 },
    };
  });
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-web', [
    { role: 'user', content: 'How old is our universe?' },
    { role: 'assistant', content: 'The universe is about 13.8 billion years old.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', 'fact-check', 'openai-codex/gpt-5.5'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') throw new Error('Expected info result.');
  expect(result.text).toContain('Web search/fetch: tavily · 10 results · 10 fetched');
  expect(runSecondOpinionWebSearchMock).toHaveBeenCalledWith({
    queries: [
      'age of universe latest cosmology measurements',
      'Planck cosmic microwave background age universe',
    ],
  });

  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(2);
  const call = callAuxiliaryModelMock.mock.calls[1]?.[0];
  const payload = JSON.parse(String(call?.messages?.[1]?.content));
  expect(payload.mode).toBe('validate');
  expect(payload.web_search_evidence.results).toHaveLength(10);
  expect(payload.web_search_evidence.results[0]).toMatchObject({
    url: 'https://example.com/source-1',
    fetchedExcerpt: 'Fetched source excerpt 1',
  });
  expect(payload.instruction).toContain('at least 10 independent Internet sources');

  const { getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const requested = getRecentStructuredAuditForSession(session.id, 10).find(
    (entry) => entry.event_type === 'second_opinion.requested',
  );
  expect(JSON.parse(requested?.payload || '{}')).toMatchObject({
    webSearchUsed: true,
    webSearchProvider: 'tavily',
    webSearchQueries: [
      'age of universe latest cosmology measurements',
      'Planck cosmic microwave background age universe',
    ],
    webSearchResults: 10,
    webSearchFetchedResults: 10,
  });
});

test('second-opinion question mode uses a same-question comparison prompt', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/gpt-5.5',
    content: JSON.stringify({
      verdict: 'Independent answer generated.',
      revised_answer: 'Ship the canary before broad rollout.',
      material_disagreements: [],
      missing_caveats: [],
      confidence: 'high',
    }),
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-compare', [
    { role: 'user', content: 'How should we roll this out?' },
    { role: 'assistant', content: 'Release it to everyone immediately.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', 'What rollout plan is safest?'],
  });

  expect(result.kind).toBe('info');
  if (result.kind !== 'info') throw new Error('Expected info result.');
  expect(result.text).toContain('Ship the canary');

  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  expect(call?.messages?.[0]?.content).toContain('same-question comparison');
  expect(call?.messages?.[0]?.content).not.toContain('active assistant draft');
  const payload = JSON.parse(String(call?.messages?.[1]?.content));
  expect(payload.mode).toBe('compare');
  expect(payload.original_question).toBe('What rollout plan is safest?');
  expect(payload).not.toHaveProperty('active_assistant_draft');
  expect(payload.recent_context).toEqual(
    expect.not.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('everyone immediately'),
      }),
    ]),
  );
});

test('second-opinion caps explicit questions before the stronger model call', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/gpt-5.5',
    content: JSON.stringify({
      verdict: 'The capped question is enough to review.',
      revised_answer: 'Use the staged rollout.',
      material_disagreements: [],
      missing_caveats: [],
      confidence: 'medium',
    }),
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(
    memoryService,
    'session-second-opinion-long-question',
    [
      { role: 'user', content: 'How should we roll this out?' },
      { role: 'assistant', content: 'Release it to everyone immediately.' },
    ],
  );
  const longQuestion = 'x'.repeat(5000);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', longQuestion],
  });

  expect(result.kind).toBe('info');
  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  const payload = JSON.parse(String(call?.messages?.[1]?.content));
  expect(payload.original_question).toContain('Question truncated to 4000');
  expect(payload.original_question.length).toBeLessThan(longQuestion.length);

  const { getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const completed = getRecentStructuredAuditForSession(session.id, 10).find(
    (entry) => entry.event_type === 'second_opinion.completed',
  );
  expect(JSON.parse(completed?.payload || '{}')).toMatchObject({
    questionTruncated: true,
  });
});

test('second-opinion reuses a fresh model catalog refresh', async () => {
  setupHome();
  const { refreshAvailableModelCatalogs } = mockModelCatalog([
    'openai-codex/gpt-5.5',
  ]);

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/gpt-5.5',
    content: JSON.stringify({
      verdict: 'The draft is acceptable.',
      revised_answer: 'Use the staged rollout.',
      material_disagreements: [],
      missing_caveats: [],
      confidence: 'medium',
    }),
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(
    memoryService,
    'session-second-opinion-catalog-cache',
    [
      { role: 'user', content: 'How should we roll this out?' },
      { role: 'assistant', content: 'Use a staged rollout.' },
    ],
  );

  for (let index = 0; index < 2; index += 1) {
    const result = await handleGatewayCommand({
      sessionId: session.id,
      guildId: null,
      channelId: 'web',
      args: ['second-opinion', '--validate-last'],
    });
    expect(result.kind).toBe('info');
  }

  expect(refreshAvailableModelCatalogs).toHaveBeenCalledTimes(1);
  expect(callAuxiliaryModelMock).toHaveBeenCalledTimes(2);
});

test('second-opinion audits model metadata cost and context estimates', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/priced'], {
    'openai-codex/priced': {
      contextWindow: 100_000,
      pricingUsdPerToken: { input: 0.001, output: 0.002 },
    },
  });

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/priced',
    content: JSON.stringify({
      verdict: 'The draft is acceptable.',
      revised_answer: 'Use the staged rollout.',
      material_disagreements: [],
      missing_caveats: [],
      confidence: 'medium',
    }),
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-cost', [
    { role: 'user', content: 'How should we roll this out?' },
    { role: 'assistant', content: 'Use a staged rollout.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last'],
  });

  expect(result.kind).toBe('info');

  const { getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const requested = getRecentStructuredAuditForSession(session.id, 10).find(
    (entry) => entry.event_type === 'second_opinion.requested',
  );
  const payload = JSON.parse(requested?.payload || '{}');
  expect(payload.modelMetadataCheck).toMatchObject({
    contextWindow: 100_000,
    pricingKnown: true,
    requestedMaxOutputTokens: 1200,
  });
  expect(payload.modelMetadataCheck.estimatedMaxCostUsd).toBeCloseTo(
    payload.modelMetadataCheck.estimatedInputTokens * 0.001 + 1200 * 0.002,
    6,
  );
});

test('second-opinion rejects models with too-small context windows before dispatch', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/tiny-context'], {
    'openai-codex/tiny-context': {
      contextWindow: 10,
      pricingUsdPerToken: { input: null, output: null },
    },
  });

  const callAuxiliaryModelMock = vi.fn();
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-context', [
    { role: 'user', content: 'How should we roll this out?' },
    { role: 'assistant', content: 'Use a staged rollout.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('exceeds the 10-token context window');
  expect(callAuxiliaryModelMock).not.toHaveBeenCalled();
});

test('second-opinion enforces configured agent budget before dispatch', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/expensive'], {
    'openai-codex/expensive': {
      contextWindow: 100_000,
      pricingUsdPerToken: { input: 1, output: 1 },
    },
  });

  const callAuxiliaryModelMock = vi.fn();
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.agents.defaultAgentId = 'main';
    const mainAgent = draft.agents.list.find((agent) => agent.id === 'main');
    if (mainAgent) {
      mainAgent.budget = { cap: 1, currency: 'USD', unit: 'USD' };
    } else {
      draft.agents.list.push({
        id: 'main',
        name: 'Main Agent',
        budget: { cap: 1, currency: 'USD', unit: 'USD' },
      });
    }
  });

  const { memoryService } = await loadGatewayFixture();
  const { runSecondOpinionCommand } = await import(
    '../src/commands/second-opinion-command.ts'
  );
  const session = seedSession(memoryService, 'session-second-opinion-budget', [
    { role: 'user', content: 'How should we roll this out?' },
    { role: 'assistant', content: 'Use a staged rollout.' },
  ]);

  await expect(
    runSecondOpinionCommand(session, ['--validate-last']),
  ).rejects.toThrow('would exceed the monthly USD budget');
  expect(callAuxiliaryModelMock).not.toHaveBeenCalled();
});

test('second-opinion fails loud when no stronger default model is configured', async () => {
  setupHome();
  mockModelCatalog([]);

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-missing', [
    { role: 'user', content: 'Is this answer right?' },
    { role: 'assistant', content: 'Probably.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('No available openai-codex model');
});

test('second-opinion rejects an explicit unavailable stronger model before dispatch', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn();
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-deny', [
    { role: 'user', content: 'Is this answer right?' },
    { role: 'assistant', content: 'Probably.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: [
      'second-opinion',
      '--validate-last',
      '--model',
      'openai-codex/not-real',
    ],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('is not available for provider "openai-codex"');
  expect(callAuxiliaryModelMock).not.toHaveBeenCalled();
});

test('second-opinion no-transcript withholds recent context from the stronger model call', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/gpt-5.5',
    content: JSON.stringify({
      verdict: 'The draft is acceptable.',
      revised_answer: 'Keep the rollout staged.',
      material_disagreements: [],
      missing_caveats: [],
      confidence: 'high',
    }),
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(
    memoryService,
    'session-second-opinion-no-transcript',
    [
      { role: 'user', content: 'Earlier local-only context: Project Falcon.' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'How should we roll this out?' },
      { role: 'assistant', content: 'Use a staged rollout.' },
    ],
  );

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last', '--no-transcript'],
  });

  expect(result.kind).toBe('info');
  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  const payload = JSON.parse(String(call?.messages?.[1]?.content));
  expect(payload.recent_context).toEqual([]);
  expect(JSON.stringify(call?.messages)).not.toContain('Project Falcon');
});

test('second-opinion redacts confidential terms before the stronger model call', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn(async () => ({
    provider: 'openai-codex' as const,
    model: 'openai-codex/gpt-5.5',
    content: JSON.stringify({
      verdict: 'The draft is acceptable.',
      revised_answer: 'Proceed with the plan for Serviceplan.',
      material_disagreements: [],
      missing_caveats: [],
      confidence: 'medium',
    }),
  }));
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { parseConfidentialYaml } = await import(
    '../src/security/confidential-rules.ts'
  );
  const { setConfidentialRuleSetForTesting } = await import(
    '../src/security/confidential-runtime.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.security.confidentialRedactionEnabled = true;
  });
  setConfidentialRuleSetForTesting(
    parseConfidentialYaml('clients:\n  - name: Serviceplan\n'),
  );

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-redact', [
    { role: 'user', content: 'What should we tell Serviceplan?' },
    { role: 'assistant', content: 'Tell Serviceplan the draft is ready.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last'],
  });

  expect(result.kind).toBe('info');
  expect(result.text).toContain('Serviceplan');
  expect(result.text).toContain('Confidential terms were redacted');

  const call = callAuxiliaryModelMock.mock.calls[0]?.[0];
  expect(JSON.stringify(call?.messages)).not.toContain('Serviceplan');
  expect(JSON.stringify(call?.messages)).toContain('«CONF:CLIENT_001»');
});

test('second-opinion parser keeps confidential placeholders JSON-safe before rehydration', async () => {
  setupHome();
  const { parseSecondOpinionVerdict } = await import(
    '../src/commands/second-opinion-command.ts'
  );

  const verdict = parseSecondOpinionVerdict(
    JSON.stringify({
      verdict: 'The draft is acceptable for «CONF:PATTERN_001».',
      revised_answer: 'Proceed with the plan for «CONF:PATTERN_001».',
      material_disagreements: ['No issue for «CONF:PATTERN_001».'],
      missing_caveats: [],
      confidence: 'medium',
    }),
  );
  const rehydrate = (text: string) =>
    text.replaceAll('«CONF:PATTERN_001»', 'Client "Quoted"');

  expect(verdict).toMatchObject({
    revisedAnswer: 'Proceed with the plan for «CONF:PATTERN_001».',
    verdict: 'The draft is acceptable for «CONF:PATTERN_001».',
    materialDisagreements: ['No issue for «CONF:PATTERN_001».'],
  });
  expect(rehydrate(verdict.revisedAnswer)).toBe(
    'Proceed with the plan for Client "Quoted".',
  );
  expect(() =>
    JSON.parse(
      JSON.stringify({
        revised_answer: 'Proceed with the plan for «CONF:PATTERN_001».',
      }).replaceAll('«CONF:PATTERN_001»', 'Client "Quoted"'),
    ),
  ).toThrow();
});

test('second-opinion blocks critical confidential payloads for remote stronger models', async () => {
  setupHome();
  mockModelCatalog(['openai-codex/gpt-5.5']);

  const callAuxiliaryModelMock = vi.fn();
  vi.doMock('../src/providers/auxiliary.js', () => ({
    callAuxiliaryModel: callAuxiliaryModelMock,
  }));

  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { parseConfidentialYaml } = await import(
    '../src/security/confidential-rules.ts'
  );
  const { setConfidentialRuleSetForTesting } = await import(
    '../src/security/confidential-runtime.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.security.confidentialRedactionEnabled = true;
  });
  setConfidentialRuleSetForTesting(
    parseConfidentialYaml(
      'projects:\n  - name: Project Falcon\n    sensitivity: critical\n',
    ),
  );

  const { memoryService, handleGatewayCommand } = await loadGatewayFixture();
  const session = seedSession(memoryService, 'session-second-opinion-block', [
    { role: 'user', content: 'What should we do for Project Falcon?' },
    { role: 'assistant', content: 'Project Falcon should not leave local.' },
  ]);

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'web',
    args: ['second-opinion', '--validate-last'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain('critical confidential policy');
  expect(callAuxiliaryModelMock).not.toHaveBeenCalled();

  const { getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.ts'
  );
  const blocked = getRecentStructuredAuditForSession(session.id, 10).find(
    (entry) => entry.event_type === 'second_opinion.blocked',
  );
  expect(JSON.parse(blocked?.payload || '{}')).toMatchObject({
    reason: 'critical_confidential_match',
    confidentialSeverity: 'critical',
  });
});
