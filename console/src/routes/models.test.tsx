import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminModelsResponse } from '../api/types';
import { ModelsPage } from './models';

const fetchModelsMock = vi.fn<() => Promise<AdminModelsResponse>>();
const saveModelsMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchModels: () => fetchModelsMock(),
  saveModels: (token: string, payload: unknown) =>
    saveModelsMock(token, payload),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeModelsResponse(
  overrides: Partial<AdminModelsResponse> = {},
): AdminModelsResponse {
  return {
    defaultModel: 'gpt-5',
    providerStatus: {
      hybridai: {
        kind: 'remote',
        reachable: true,
        latencyMs: 12,
        modelCount: 1,
        detail: '12ms',
      },
    },
    models: [
      {
        id: 'gpt-5',
        discovered: false,
        backend: null,
        contextWindow: 128000,
        maxTokens: 8192,
        isReasoning: false,
        thinkingFormat: null,
        family: null,
        parameterSize: null,
        usageDaily: null,
        usageMonthly: null,
      },
      {
        id: 'openrouter/anthropic/claude-sonnet-4',
        discovered: true,
        backend: null,
        contextWindow: 200000,
        maxTokens: 8192,
        isReasoning: true,
        thinkingFormat: null,
        family: 'claude',
        parameterSize: null,
        usageDaily: null,
        usageMonthly: null,
      },
    ],
    ...overrides,
  };
}

function renderModelsPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ModelsPage />
    </QueryClientProvider>,
  );
}

describe('ModelsPage', () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
    saveModelsMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      token: 'test-token',
    });
  });

  it('surfaces providers inferred from the catalog when health data is missing', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());

    renderModelsPage();

    expect(await screen.findByText('openrouter')).not.toBeNull();
    expect(screen.getByText('Visible in catalog · no live health data')).not.toBeNull();
    expect(screen.getByText('catalog')).not.toBeNull();
  });

  it('sorts the catalog by monthly usage descending by default', async () => {
    fetchModelsMock.mockResolvedValue(
      makeModelsResponse({
        models: [
          {
            id: 'openrouter/anthropic/claude-sonnet-4',
            discovered: true,
            backend: null,
            contextWindow: 200000,
            maxTokens: 8192,
            isReasoning: true,
            thinkingFormat: null,
            family: 'claude',
            parameterSize: null,
            usageDaily: null,
            usageMonthly: {
              totalInputTokens: 100,
              totalOutputTokens: 50,
              totalTokens: 150,
              totalCostUsd: 1.25,
              callCount: 3,
              totalToolCalls: 0,
            },
          },
          {
            id: 'gpt-5',
            discovered: false,
            backend: null,
            contextWindow: 128000,
            maxTokens: 8192,
            isReasoning: false,
            thinkingFormat: null,
            family: null,
            parameterSize: null,
            usageDaily: null,
            usageMonthly: {
              totalInputTokens: 500,
              totalOutputTokens: 250,
              totalTokens: 750,
              totalCostUsd: 3.5,
              callCount: 9,
              totalToolCalls: 0,
            },
          },
          {
            id: 'openai-codex/gpt-5.4',
            discovered: false,
            backend: null,
            contextWindow: 400000,
            maxTokens: 32768,
            isReasoning: true,
            thinkingFormat: null,
            family: null,
            parameterSize: null,
            usageDaily: null,
            usageMonthly: null,
          },
        ],
      }),
    );

    renderModelsPage();

    const rows = await screen.findAllByRole('row');
    const bodyRows = rows.slice(1, 4);
    expect(within(bodyRows[0] as HTMLElement).getByText('gpt-5')).not.toBeNull();
    expect(
      within(bodyRows[1] as HTMLElement).getByText(
        'openrouter/anthropic/claude-sonnet-4',
      ),
    ).not.toBeNull();
    expect(
      within(bodyRows[2] as HTMLElement).getByText('openai-codex/gpt-5.4'),
    ).not.toBeNull();
  });

  it('shows discovery-only guidance instead of editable provider model lists', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());

    renderModelsPage();

    expect(
      await screen.findByText(
        'Provider catalogs are auto-discovered. Only the default model is configurable here.',
      ),
    ).not.toBeNull();
    expect(
      screen.queryByText('Configured HybridAI models'),
    ).toBeNull();
    expect(screen.queryByText('Configured Codex models')).toBeNull();
  });
});
