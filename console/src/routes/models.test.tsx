import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminModelsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ModelsPage } from './models';

const fetchModelsMock = vi.fn<() => Promise<AdminModelsResponse>>();
const saveModelsMock = vi.fn();
const useAuthMock = vi.fn();

const modelMetadataDefaults = {
  pricingUsdPerToken: { input: null, output: null },
  capabilities: {
    vision: true,
    tools: true,
    jsonMode: true,
    reasoning: false,
  },
  metadataSources: [],
};

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
        provider: 'hybridai',
        discovered: false,
        backend: null,
        contextWindow: 128000,
        maxTokens: 8192,
        ...modelMetadataDefaults,
        isReasoning: false,
        thinkingFormat: null,
        family: null,
        parameterSize: null,
        usageDaily: null,
        usageMonthly: null,
      },
      {
        id: 'openrouter/anthropic/claude-sonnet-4',
        provider: 'openrouter',
        discovered: true,
        backend: null,
        contextWindow: 200000,
        maxTokens: 8192,
        ...modelMetadataDefaults,
        capabilities: {
          ...modelMetadataDefaults.capabilities,
          reasoning: true,
        },
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
  renderWithProviders(<ModelsPage />);
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
    expect(
      screen.getByText('Visible in catalog · no live health data'),
    ).not.toBeNull();
    expect(screen.getByText('catalog')).not.toBeNull();
  });

  it('sorts the catalog by monthly usage descending by default', async () => {
    fetchModelsMock.mockResolvedValue(
      makeModelsResponse({
        models: [
          {
            id: 'openrouter/anthropic/claude-sonnet-4',
            provider: 'openrouter',
            discovered: true,
            backend: null,
            contextWindow: 200000,
            maxTokens: 8192,
            ...modelMetadataDefaults,
            capabilities: {
              ...modelMetadataDefaults.capabilities,
              reasoning: true,
            },
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
            provider: 'hybridai',
            discovered: false,
            backend: null,
            contextWindow: 128000,
            maxTokens: 8192,
            ...modelMetadataDefaults,
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
            provider: 'codex',
            discovered: false,
            backend: null,
            contextWindow: 400000,
            maxTokens: 32768,
            ...modelMetadataDefaults,
            capabilities: {
              ...modelMetadataDefaults.capabilities,
              reasoning: true,
            },
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
    expect(
      within(bodyRows[0] as HTMLElement).getByText('gpt-5'),
    ).not.toBeNull();
    expect(
      within(bodyRows[1] as HTMLElement).getByText(
        'openrouter/anthropic/claude-sonnet-4',
      ),
    ).not.toBeNull();
    expect(
      within(bodyRows[2] as HTMLElement).getByText('openai-codex/gpt-5.4'),
    ).not.toBeNull();
  });

  it('does not show editable provider model lists', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());

    renderModelsPage();

    await screen.findByText('Default model');
    expect(screen.queryByText('Configured HybridAI models')).toBeNull();
    expect(screen.queryByText('Configured Codex models')).toBeNull();
  });

  it('changes the default model through NativeSelect and saves it', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());
    saveModelsMock.mockResolvedValue(undefined);

    renderModelsPage();

    const select = (await screen.findByLabelText(
      'Default model',
    )) as HTMLSelectElement;
    expect(select.value).toBe('gpt-5');

    fireEvent.change(select, {
      target: { value: 'openrouter/anthropic/claude-sonnet-4' },
    });
    expect(select.value).toBe('openrouter/anthropic/claude-sonnet-4');

    fireEvent.click(screen.getByRole('button', { name: 'Save selection' }));

    await waitFor(() => expect(saveModelsMock).toHaveBeenCalledTimes(1));
    expect(saveModelsMock).toHaveBeenCalledWith('test-token', {
      defaultModel: 'openrouter/anthropic/claude-sonnet-4',
    });
  });
});
