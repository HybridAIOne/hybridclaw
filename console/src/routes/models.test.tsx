import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminBrowserModelBridgeResponse,
  AdminModelsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ModelsPage } from './models';

const fetchModelsMock = vi.fn<() => Promise<AdminModelsResponse>>();
const saveModelsMock = vi.fn();
const fetchBrowserModelBridgeMock =
  vi.fn<() => Promise<AdminBrowserModelBridgeResponse>>();
const startBrowserModelBridgeMock = vi.fn();
const stopBrowserModelBridgeMock = vi.fn();
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
  fetchBrowserModelBridge: () => fetchBrowserModelBridgeMock(),
  fetchModels: () => fetchModelsMock(),
  saveModels: (token: string, payload: unknown) =>
    saveModelsMock(token, payload),
  startBrowserModelBridge: (token: string, payload: unknown) =>
    startBrowserModelBridgeMock(token, payload),
  stopBrowserModelBridge: (token: string) => stopBrowserModelBridgeMock(token),
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

function makeBrowserBridgeResponse(
  overrides: {
    bridge?: Partial<AdminBrowserModelBridgeResponse['bridge']>;
    models?: AdminModelsResponse;
  } = {},
): AdminBrowserModelBridgeResponse {
  return {
    bridge: {
      running: false,
      host: '127.0.0.1',
      port: 8789,
      model: 'LiquidAI/LFM2.5-230M-ONNX',
      device: 'webgpu',
      dtype: 'q4',
      maxNewTokens: 2048,
      pageUrl: 'http://127.0.0.1:8789/',
      endpointUrl: 'http://127.0.0.1:8789/v1',
      configuredModel: 'browser/LiquidAI/LFM2.5-230M-ONNX',
      configuredDefault: false,
      ...overrides.bridge,
    },
    models: overrides.models || makeModelsResponse(),
  };
}

function renderModelsPage(): void {
  renderWithProviders(<ModelsPage />);
}

describe('ModelsPage', () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
    saveModelsMock.mockReset();
    fetchBrowserModelBridgeMock.mockReset();
    startBrowserModelBridgeMock.mockReset();
    stopBrowserModelBridgeMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      token: 'test-token',
    });
    fetchBrowserModelBridgeMock.mockResolvedValue(makeBrowserBridgeResponse());
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
    const bodyRows = rows.slice(1, 3);
    expect(
      within(bodyRows[0] as HTMLElement).getByText('gpt-5'),
    ).not.toBeNull();
    expect(
      within(bodyRows[1] as HTMLElement).getByText(
        'openrouter/anthropic/claude-sonnet-4',
      ),
    ).not.toBeNull();
    expect(bodyRows).toHaveLength(2);
  });

  it('defaults the catalog to active models and can switch to all models', async () => {
    fetchModelsMock.mockResolvedValue(
      makeModelsResponse({
        models: [
          {
            id: 'active-model',
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
              totalInputTokens: 10,
              totalOutputTokens: 5,
              totalTokens: 15,
              totalCostUsd: 0.02,
              callCount: 1,
              totalToolCalls: 0,
            },
          },
          {
            id: 'inactive-model',
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
        ],
      }),
    );

    renderModelsPage();

    const catalogView = (await screen.findByLabelText(
      'Catalog view',
    )) as HTMLSelectElement;
    expect(catalogView.value).toBe('active');
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    let bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(1);
    expect(
      within(bodyRows[0] as HTMLElement).getByText('active-model'),
    ).not.toBeNull();

    fireEvent.change(catalogView, { target: { value: 'all' } });

    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(2);
    expect(
      within(bodyRows[0] as HTMLElement).getByText('active-model'),
    ).not.toBeNull();
    expect(
      within(bodyRows[1] as HTMLElement).getByText('inactive-model'),
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

  it('starts the browser model bridge from the models page', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());
    const startedPayload = makeBrowserBridgeResponse({
      bridge: {
        running: true,
        configuredDefault: true,
      },
      models: makeModelsResponse({
        defaultModel: 'browser/LiquidAI/LFM2.5-230M-ONNX',
      }),
    });
    startBrowserModelBridgeMock.mockResolvedValue(startedPayload);
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderModelsPage();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Start bridge' }),
    );

    await waitFor(() =>
      expect(startBrowserModelBridgeMock).toHaveBeenCalledTimes(1),
    );
    expect(startBrowserModelBridgeMock).toHaveBeenCalledWith('test-token', {
      model: 'LiquidAI/LFM2.5-230M-ONNX',
      host: '127.0.0.1',
      port: 8789,
      device: 'webgpu',
      dtype: 'q4',
      maxNewTokens: 2048,
      setDefault: true,
    });
    expect(openMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8789/',
      '_blank',
      'noopener,noreferrer',
    );
    openMock.mockRestore();
  });

  it('shows only supported quantizations for the selected browser model', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());

    renderModelsPage();

    const select = (await screen.findByLabelText(
      'Quantization',
    )) as HTMLSelectElement;

    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'q4',
      'q4f32',
      'q8',
      'fp16',
      'fp32',
    ]);
    expect(screen.queryByText('Dtype')).toBeNull();
    expect(screen.queryByRole('option', { name: 'q4f16' })).toBeNull();
  });

  it('preserves the selected quantization after starting the browser bridge', async () => {
    fetchModelsMock.mockResolvedValue(makeModelsResponse());
    const startedPayload = makeBrowserBridgeResponse({
      bridge: {
        running: true,
        configuredDefault: true,
        dtype: 'q8',
      },
      models: makeModelsResponse({
        defaultModel: 'browser/LiquidAI/LFM2.5-230M-ONNX',
      }),
    });
    startBrowserModelBridgeMock.mockResolvedValue(startedPayload);
    const openMock = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderModelsPage();

    const select = (await screen.findByLabelText(
      'Quantization',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'q8' } });

    fireEvent.click(screen.getByRole('button', { name: 'Start bridge' }));

    await waitFor(() =>
      expect(startBrowserModelBridgeMock).toHaveBeenCalledTimes(1),
    );
    expect(startBrowserModelBridgeMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({ dtype: 'q8' }),
    );
    await waitFor(() => expect(select.value).toBe('q8'));

    openMock.mockRestore();
  });
});
