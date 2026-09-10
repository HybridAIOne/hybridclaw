import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type { AdminLocalModelsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { LocalModelsPage } from './local-models';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), control: vi.fn() }));
vi.mock('../api/client', () => ({
  fetchLocalModels: mocks.fetch,
  controlLocalModel: mocks.control,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-key' }) }));
const GIB = 1024 ** 3;
function status(
  overrides: Partial<AdminLocalModelsResponse> = {},
): AdminLocalModelsResponse {
  return {
    hardware: { chip: 'Example Mac', memoryBytes: 32 * GIB },
    supported: true,
    uvAvailable: true,
    reservedBytes: 8 * GIB,
    memoryLimitBytes: 24 * GIB,
    freeDiskBytes: 100 * GIB,
    recommended: 'spark-x2.5-4b',
    candidates: [
      {
        id: 'spark-x2.5-4b',
        label: 'Spark-X2.5 4B',
        note: 'Small coding model.',
        repo: 'example/model',
        revision: 'a'.repeat(40),
        license: 'Apache-2.0',
        weightBytes: 3 * GIB,
        requiredBytes: 5 * GIB,
        contextWindow: 8192,
        fits: true,
      },
    ],
    unavailable: [
      {
        id: 'future-model',
        label: 'Future model',
        sourceRepo: 'example/future',
        reason: 'No supported artifact.',
      },
    ],
    installation: null,
    installationError: null,
    running: false,
    metrics: {
      sampledAt: 1000,
      cpuPercent: null,
      memoryUsedBytes: 16 * GIB,
      memoryTotalBytes: 32 * GIB,
      gpuPercent: null,
      tokensPerSecond: 0,
      generatedTokens: 0,
      runtimeId: null,
    },
    job: null,
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(status());
  mocks.control.mockResolvedValue({ accepted: true });
});
test('shows capacity and submits the recommended pinned catalog ID', async () => {
  renderWithProviders(<LocalModelsPage />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Download & set up' }),
  );
  await waitFor(() =>
    expect(mocks.control).toHaveBeenCalledWith('test-key', {
      action: 'setup',
      modelId: 'spark-x2.5-4b',
    }),
  );
  expect(screen.getByText('Example Mac')).toBeDefined();
  expect(screen.getByText('Recommended for this Mac')).toBeDefined();
});
test.each([
  { uvAvailable: false },
  { freeDiskBytes: GIB },
  { candidates: status().candidates.map((m) => ({ ...m, fits: false })) },
])('prevents installation when prerequisites fail: %j', async (overrides) => {
  mocks.fetch.mockResolvedValue(status(overrides));
  renderWithProviders(<LocalModelsPage />);
  expect(
    (
      (await screen.findByRole('button', {
        name: 'Download & set up',
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(mocks.control).not.toHaveBeenCalled();
});
test('restores background progress on page entry and allows cancellation', async () => {
  mocks.fetch.mockResolvedValue(
    status({
      job: {
        action: 'setup',
        modelId: 'spark-x2.5-4b',
        stage: 'download',
        status: 'running',
        error: null,
      },
    }),
  );
  renderWithProviders(<LocalModelsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(mocks.control).toHaveBeenCalledWith('test-key', {
      action: 'cancel',
    }),
  );
  expect(
    screen.queryByRole('button', { name: 'Download & set up' }),
  ).toBeNull();
});
test('shows runtime controls for an installed model', async () => {
  mocks.fetch.mockResolvedValue(
    status({
      installation: { modelId: 'spark-x2.5-4b', contextWindow: 4096 },
      running: true,
    }),
  );
  const { queryClient } = renderWithProviders(<LocalModelsPage />);
  queryClient.setQueryData(['models', 'test-key'], { models: [] });
  fireEvent.click(await screen.findByRole('button', { name: 'Stop model' }));
  await waitFor(() =>
    expect(mocks.control).toHaveBeenCalledWith('test-key', { action: 'stop' }),
  );
  await waitFor(() =>
    expect(
      queryClient.getQueryState(['models', 'test-key'])?.isInvalidated,
    ).toBe(true),
  );
  expect(
    screen.queryByRole('button', { name: 'Download & set up' }),
  ).toBeNull();
});
test('reports an unavailable gateway API with a refresh action', async () => {
  mocks.fetch.mockRejectedValue(new Error('Not Found'));
  renderWithProviders(<LocalModelsPage />);
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(
    screen.getByText('Local model controls are unavailable'),
  ).toBeDefined();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
});

test('does not recommend or offer setup for the installed stopped model', async () => {
  mocks.fetch.mockResolvedValue(
    status({ installation: { modelId: 'spark-x2.5-4b', contextWindow: 4096 } }),
  );
  renderWithProviders(<LocalModelsPage />);
  expect(
    await screen.findByRole('button', { name: 'Start model' }),
  ).toBeDefined();
  expect(screen.queryByText('Recommended for this Mac')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Set up selected model' }),
  ).toBeNull();
  expect(screen.queryByText(/No model currently fits/)).toBeNull();
  fireEvent.click(screen.getByText('Compare models from the shortlist'));
  expect(
    (screen.getByRole('button', { name: 'Installed' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.queryByRole('button', { name: 'Choose Spark-X2.5 4B' }),
  ).toBeNull();
});

test('keeps other shortlist models available when the recommendation is installed', async () => {
  const other = {
    ...status().candidates[0],
    id: 'qwen3.8-27b',
    label: 'Qwen3.8 27B',
  };
  mocks.fetch.mockResolvedValue(
    status({
      candidates: [...status().candidates, other],
      installation: { modelId: 'spark-x2.5-4b', contextWindow: 4096 },
    }),
  );
  renderWithProviders(<LocalModelsPage />);
  await screen.findByRole('button', { name: 'Start model' });
  fireEvent.click(screen.getByText('Compare models from the shortlist'));
  fireEvent.click(screen.getByRole('button', { name: 'Choose Qwen3.8 27B' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Set up selected model' }),
  );
  await waitFor(() =>
    expect(mocks.control).toHaveBeenCalledWith('test-key', {
      action: 'setup',
      modelId: 'qwen3.8-27b',
    }),
  );
});

test('removes the setup recommendation after installation completes', async () => {
  mocks.control.mockImplementation(async () => {
    mocks.fetch.mockResolvedValue(
      status({
        installation: { modelId: 'spark-x2.5-4b', contextWindow: 8192 },
      }),
    );
    return { accepted: true };
  });
  renderWithProviders(<LocalModelsPage />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Download & set up' }),
  );
  await screen.findByRole('button', { name: 'Start model' });
  expect(screen.queryByText('Recommended for this Mac')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Set up selected model' }),
  ).toBeNull();
});

test.each([
  true,
  false,
])('invalidates picker status when background health changes to %s', async (running) => {
  const installation = { modelId: 'spark-x2.5-4b', contextWindow: 40960 };
  mocks.fetch.mockResolvedValue(status({ installation, running: !running }));
  const { queryClient } = renderWithProviders(<LocalModelsPage />);
  await screen.findByRole('button', {
    name: running ? 'Start model' : 'Stop model',
  });
  queryClient.setQueryData(['models', 'test-key'], { models: [] });
  expect(queryClient.getQueryState(['models', 'test-key'])?.isInvalidated).toBe(
    false,
  );

  // The job finishes after command acceptance; this is the later polling response.
  await act(async () => {
    queryClient.setQueryData(
      ['local-models', 'test-key'],
      status({ installation, running }),
    );
  });
  await waitFor(() =>
    expect(
      queryClient.getQueryState(['models', 'test-key'])?.isInvalidated,
    ).toBe(true),
  );
  queryClient.setQueryData(['models', 'test-key'], { models: [] });
  await act(async () => {
    queryClient.setQueryData(
      ['local-models', 'test-key'],
      status({ installation, running, freeDiskBytes: 80 * GIB }),
    );
  });
  expect(queryClient.getQueryState(['models', 'test-key'])?.isInvalidated).toBe(
    false,
  );
});
