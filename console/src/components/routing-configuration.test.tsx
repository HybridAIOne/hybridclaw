import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatModel } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { RoutingConfiguration } from './routing-configuration';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn(),
  available: true,
}));
vi.mock('../api/client', () => ({
  fetchConfig: mocks.fetch,
  saveConfig: mocks.save,
  requestJson: () => Promise.resolve({ jevAvailable: mocks.available }),
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
const models = [
  { id: 'local-model', zone: 'local' },
  { id: 'cloud-model', zone: 'cloud' },
] as ChatModel[];
const routing = {
  enabled: true,
  showRoutingInfo: true,
  defaultStart: 'Local',
  escalationStickyTurns: 3,
  concierge: { model: '' },
  mode: 'auto',
  preference: 'balanced',
  tiers: [
    { name: 'Local', models: ['local-model'] },
    { name: 'Cloud', models: ['cloud-model'] },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.available = true;
  mocks.fetch.mockResolvedValue({ config: { routing } });
  mocks.save.mockImplementation((_token, config) =>
    Promise.resolve({ config }),
  );
});
async function renderEditor() {
  renderWithProviders(<RoutingConfiguration models={models} />);
  await screen.findByLabelText('Tier 1 name');
}
it('renames the starting tier and merges into fresh config without overwriting other settings', async () => {
  await renderEditor();
  fireEvent.change(screen.getByLabelText('Tier 1 name'), {
    target: { value: 'Fast' },
  });
  mocks.fetch.mockResolvedValue({
    config: {
      routing: { ...routing, showRoutingInfo: false, escalationStickyTurns: 5 },
      unrelated: true,
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      unrelated: true,
      routing: {
        ...routing,
        showRoutingInfo: false,
        escalationStickyTurns: 5,
        defaultStart: 'Fast',
        tiers: [{ name: 'Fast', models: ['local-model'] }, routing.tiers[1]],
      },
    }),
  );
});
it('reorders tiers and chooses a valid start when the starting tier is removed', async () => {
  await renderEditor();
  fireEvent.click(screen.getByRole('button', { name: 'Move tier 1 later' }));
  expect((screen.getByLabelText('Tier 1 name') as HTMLInputElement).value).toBe(
    'Cloud',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove tier 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      routing: { ...routing, defaultStart: 'Cloud', tiers: [routing.tiers[1]] },
    }),
  );
});
it('blocks duplicate names and empty model slots and supports discard', async () => {
  await renderEditor();
  fireEvent.change(screen.getByLabelText('Tier 2 name'), {
    target: { value: ' local ' },
  });
  expect(screen.getByRole('alert').textContent).toContain('different name');
  expect(
    screen
      .getByRole('button', { name: 'Save routing' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  fireEvent.click(screen.getByRole('button', { name: '+ Add tier' }));
  expect(screen.getByRole('alert').textContent).toContain('Choose a model');
  fireEvent.change(screen.getByLabelText('Tier 3 model 1'), {
    target: { value: 'cloud-model' },
  });
  expect(screen.queryByRole('alert')).toBeNull();
});
it('preserves the draft after a rejected save', async () => {
  await renderEditor();
  mocks.save.mockRejectedValueOnce(new Error('Save rejected'));
  fireEvent.change(screen.getByLabelText('Tier 1 name'), {
    target: { value: 'Fast' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Save rejected',
  );
  expect((screen.getByLabelText('Tier 1 name') as HTMLInputElement).value).toBe(
    'Fast',
  );
});
it('preserves existing backups and permits replacing a missing catalog model', async () => {
  mocks.fetch.mockResolvedValue({
    config: {
      routing: {
        ...routing,
        tiers: [{ name: 'Local', models: ['old-model', 'cloud-model'] }],
      },
    },
  });
  await renderEditor();
  expect(
    screen.getByRole('option', { name: 'old-model · not in current catalog' }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tier 1 model 1'), {
    target: { value: 'local-model' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      routing: {
        ...routing,
        tiers: [{ name: 'Local', models: ['local-model', 'cloud-model'] }],
      },
    }),
  );
});

it('registers selected discovered remote models while preserving provider settings', async () => {
  const catalog = [
    { id: 'anthropic/new-model', provider: 'anthropic', backend: null },
    { id: 'openai-codex/new-model', provider: 'openai-codex', backend: null },
    { id: 'hybridai/new-model', provider: 'hybridai', backend: null },
    { id: 'edge/local-model', provider: 'vllm', backend: 'vllm' },
    { id: 'anthropic/unselected-model', provider: 'anthropic', backend: null },
  ] as ChatModel[];
  const config = {
    routing: {
      ...routing,
      tiers: [
        { name: 'Local', models: catalog.slice(0, 4).map((model) => model.id) },
      ],
    },
    anthropic: {
      enabled: true,
      models: ['anthropic/existing-model'],
      baseUrl: 'https://example.com',
    },
    codex: { models: ['openai-codex/existing-model'] },
    hybridai: { models: ['hybridai/new-model'] },
    vllm: { models: [] },
  };
  mocks.fetch.mockResolvedValue({ config });
  renderWithProviders(<RoutingConfiguration models={catalog} />);
  fireEvent.change(await screen.findByLabelText('Tier 1 name'), {
    target: { value: 'Cloud' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      ...config,
      routing: {
        ...config.routing,
        defaultStart: 'Cloud',
        tiers: [
          {
            name: 'Cloud',
            models: catalog.slice(0, 4).map((model) => model.id),
          },
        ],
      },
      anthropic: {
        ...config.anthropic,
        models: ['anthropic/existing-model', 'anthropic/new-model'],
      },
      codex: {
        models: ['openai-codex/existing-model', 'openai-codex/new-model'],
      },
    }),
  );
});

it('does not register a configured model missing from the discovered catalog', async () => {
  const config = {
    routing: {
      ...routing,
      tiers: [{ name: 'Local', models: ['anthropic/missing-model'] }],
    },
    anthropic: { models: ['anthropic/existing-model'] },
  };
  mocks.fetch.mockResolvedValue({ config });
  await renderEditor();
  fireEvent.change(screen.getByLabelText('Tier 1 name'), {
    target: { value: 'Cloud' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      ...config,
      routing: {
        ...config.routing,
        defaultStart: 'Cloud',
        tiers: [{ name: 'Cloud', models: ['anthropic/missing-model'] }],
      },
    }),
  );
});

it('saves independent live and comparison models and can unset comparison', async () => {
  await renderEditor();
  fireEvent.change(screen.getByLabelText('1st router · Live'), {
    target: { value: 'local-model' },
  });
  fireEvent.change(screen.getByLabelText('2nd router · Compare'), {
    target: { value: 'cloud-model' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        routing: expect.objectContaining({
          concierge: { model: 'local-model', comparisonModel: 'cloud-model' },
        }),
      }),
    ),
  );
  fireEvent.change(screen.getByLabelText('2nd router · Compare'), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenLastCalledWith(
      'test-token',
      expect.objectContaining({
        routing: expect.objectContaining({
          concierge: { model: 'local-model', comparisonModel: '' },
        }),
      }),
    ),
  );
});

it('shows JEV as disabled and comparison unset without a key', async () => {
  mocks.available = false;
  await renderEditor();
  await waitFor(() =>
    expect(
      (screen.getByLabelText('2nd router · Compare') as HTMLSelectElement)
        .value,
    ).toBe(''),
  );
  expect(
    screen
      .getAllByRole('option', { name: 'JEV · API key required' })
      .every((option) => option.hasAttribute('disabled')),
  ).toBe(true);
});

it('removes preference and blocks Privacy when all tier models are remote', async () => {
  mocks.fetch.mockResolvedValue({
    config: {
      routing: {
        ...routing,
        tiers: [{ name: 'Cloud', models: ['cloud-model'] }],
        defaultStart: 'Cloud',
      },
    },
  });
  await renderEditor();
  expect(screen.queryByLabelText('Preference')).toBeNull();
  fireEvent.change(screen.getByLabelText('Mode'), {
    target: { value: 'privacy' },
  });
  expect(screen.getByRole('alert').textContent).toContain(
    'Configure a local model first',
  );
  expect(
    screen
      .getByRole('button', { name: 'Save routing' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Tier 1 model 1'), {
    target: { value: 'local-model' },
  });
  expect(screen.queryByRole('alert')).toBeNull();
});
