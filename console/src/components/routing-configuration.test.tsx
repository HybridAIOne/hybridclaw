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
  maximumZone: 'cloud',
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
        tiers: [
          expect.objectContaining({ name: 'Fast', models: ['local-model'] }),
          expect.objectContaining(routing.tiers[1]),
        ],
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
      routing: {
        ...routing,
        defaultStart: 'Cloud',
        tiers: [expect.objectContaining(routing.tiers[1])],
      },
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
        tiers: [
          expect.objectContaining({
            name: 'Local',
            models: ['local-model', 'cloud-model'],
          }),
        ],
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
          expect.objectContaining({
            name: 'Cloud',
            models: catalog.slice(0, 4).map((model) => model.id),
          }),
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
        tiers: [
          expect.objectContaining({
            name: 'Cloud',
            models: ['anthropic/missing-model'],
          }),
        ],
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
  fireEvent.change(screen.getByRole('slider', { name: 'Privacy boundary' }), {
    target: { value: '0' },
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
  fireEvent.change(screen.getByLabelText('1st router · Live'), {
    target: { value: 'local-model' },
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps independent model assignments when switching modes and saving', async () => {
  await renderEditor();
  fireEvent.change(screen.getByLabelText('Mode'), {
    target: { value: 'cost' },
  });
  fireEvent.change(screen.getByLabelText('Tier 1 model 1'), {
    target: { value: 'cloud-model' },
  });
  fireEvent.change(screen.getByLabelText('Mode'), {
    target: { value: 'auto' },
  });
  expect(
    (screen.getByLabelText('Tier 1 model 1') as HTMLSelectElement).value,
  ).toBe('local-model');
  fireEvent.change(screen.getByLabelText('Mode'), {
    target: { value: 'cost' },
  });
  expect(
    (screen.getByLabelText('Tier 1 model 1') as HTMLSelectElement).value,
  ).toBe('cloud-model');
  fireEvent.click(screen.getByRole('button', { name: 'Save routing' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  const saved = mocks.save.mock.calls.at(-1)![1].routing;
  expect(saved.tiers[0].modelsByMode.auto).toEqual(['local-model']);
  expect(saved.tiers[0].modelsByMode.cost).toEqual(['cloud-model']);
  expect(saved.mode).toBe('cost');
});

it('prefills Cost and Speed from capable models and restores Auto assignments', async () => {
  mocks.fetch.mockResolvedValue({
    config: {
      routing: {
        ...routing,
        tiers: [{ name: 'Local', models: ['local-model', 'cloud-model'] }],
      },
    },
  });
  const catalog = models.map((model) => ({
    ...model,
    latencyMs: model.id === 'cloud-model' ? 10 : 100,
    pricingUsdPerToken: {
      input: model.id === 'cloud-model' ? 1 : 3,
      output: 1,
    },
  }));
  renderWithProviders(<RoutingConfiguration models={catalog} />);
  await screen.findByLabelText('Tier 1 name');
  for (const mode of ['cost', 'speed']) {
    fireEvent.change(screen.getByLabelText('Mode'), {
      target: { value: mode },
    });
    expect(
      (screen.getByLabelText('Tier 1 model 1') as HTMLSelectElement).value,
    ).toBe('cloud-model');
  }
  fireEvent.change(screen.getByLabelText('Mode'), {
    target: { value: 'auto' },
  });
  expect(
    (screen.getByLabelText('Tier 1 model 1') as HTMLSelectElement).value,
  ).toBe('local-model');
});

it('local-only hides cloud selections and choices in every mode, without losing tier assignments', async () => {
  await renderEditor();
  fireEvent.change(screen.getByRole('slider', { name: 'Privacy boundary' }), {
    target: { value: '0' },
  });
  for (const mode of ['auto', 'privacy', 'speed', 'cost']) {
    fireEvent.change(screen.getByLabelText('Mode'), {
      target: { value: mode },
    });
    expect(
      screen
        .queryAllByRole('option')
        .some((option) => option.textContent?.includes('cloud-model')),
    ).toBe(false);
    expect(screen.queryAllByRole('option', { name: /^JEV/ })).toHaveLength(0);
    expect(
      (screen.getByLabelText('Tier 2 model 1') as HTMLSelectElement).value,
    ).toBe('');
    expect(
      screen
        .getByRole('button', { name: 'Save routing' })
        .hasAttribute('disabled'),
    ).toBe(true);
  }
  fireEvent.change(screen.getByRole('slider', { name: 'Privacy boundary' }), {
    target: { value: '4' },
  });
  expect(
    (screen.getByLabelText('Tier 2 model 1') as HTMLSelectElement).value,
  ).toBe('cloud-model');
});

it('never copies the next tier into generated mode backups', async () => {
  await renderEditor();
  for (const mode of ['privacy', 'speed', 'cost', 'auto']) {
    fireEvent.change(screen.getByLabelText('Mode'), {
      target: { value: mode },
    });
    expect(
      (screen.getByLabelText('Tier 1 model 1') as HTMLSelectElement).value,
    ).toBe('local-model');
    expect(
      (screen.getByLabelText('Tier 2 model 1') as HTMLSelectElement).value,
    ).toBe('cloud-model');
    expect(screen.queryByLabelText('Tier 1 model 2')).toBeNull();
  }
});

it('privacy previews show three catalog models in capability order and exclude undiscovered local models', async () => {
  const catalog = [
    { id: 'basic', zone: 'hai' },
    { id: 'general', zone: 'hai' },
    { id: 'advanced', zone: 'hai' },
    { id: 'extra', zone: 'hai' },
    { id: 'offline', zone: 'local', backend: 'ollama', discovered: false },
  ] as ChatModel[];
  mocks.fetch.mockResolvedValue({
    config: {
      routing: {
        ...routing,
        defaultStart: 'basic',
        tiers: [
          { name: 'basic', models: ['basic'] },
          { name: 'general', models: ['general'] },
          { name: 'advanced', models: ['advanced'] },
        ],
      },
    },
  });
  renderWithProviders(<RoutingConfiguration models={catalog} />);
  await screen.findByLabelText('Tier 1 name');
  const preview = document.getElementById('privacy-models-hai');
  expect(preview?.textContent).toContain('HybridAI');
  expect(
    [...preview!.querySelectorAll(':scope > span')].map(
      (item) => item.textContent,
    ),
  ).toEqual(['advanced', 'general', 'basic']);
  expect(
    document.getElementById('privacy-models-local')?.textContent,
  ).toContain('No models available');
});

it('clicking privacy labels and icons selects the matching slider stop', async () => {
  await renderEditor();
  const slider = screen.getByRole('slider', { name: 'Privacy boundary' });
  fireEvent.click(screen.getByRole('button', { name: 'HybridAI' }));
  expect((slider as HTMLInputElement).value).toBe('1');
  expect(
    screen
      .getByRole('button', { name: 'HybridAI' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(
    screen.getByRole('button', { name: 'World' }).querySelector('svg')!,
  );
  expect((slider as HTMLInputElement).value).toBe('4');
});

it('marks HybridAI and Local inactive from provider health', async () => {
  renderWithProviders(
    <RoutingConfiguration
      models={models}
      providerStatus={{
        hybridai: { kind: 'remote', reachable: false, loginRequired: true },
      }}
    />,
  );
  await screen.findByLabelText('Tier 1 name');
  expect(screen.getByRole('button', { name: 'Local' }).textContent).toContain(
    'Inactive',
  );
  expect(
    screen.getByRole('button', { name: 'HybridAI' }).textContent,
  ).toContain('Inactive');
  expect(document.getElementById('privacy-models-hai')?.textContent).toContain(
    'Activate your HybridAI API key',
  );
});
it('active credentials and reachable local LLMs enable the availability indicators', async () => {
  renderWithProviders(
    <RoutingConfiguration
      models={[
        { id: 'hybridai/qwen', zone: 'hai', provider: 'hybridai' } as ChatModel,
        {
          id: 'lmstudio/chat-model',
          zone: 'local',
          provider: 'lmstudio',
          backend: 'lmstudio',
          discovered: true,
        } as ChatModel,
      ]}
      providerStatus={{
        hybridai: { kind: 'remote', reachable: true },
        lmstudio: { kind: 'local', reachable: true },
      }}
    />,
  );
  await screen.findByLabelText('Tier 1 name');
  expect(
    screen.getByRole('button', { name: 'Local' }).textContent,
  ).not.toContain('Inactive');
  expect(
    screen.getByRole('button', { name: 'HybridAI' }).textContent,
  ).not.toContain('Inactive');
});

it('disables unconfigured privacy levels and skips them when moving the slider', async () => {
  renderWithProviders(
    <RoutingConfiguration
      models={models}
      providerStatus={{
        'local-model': { kind: 'local', reachable: true },
        'cloud-model': { kind: 'remote', reachable: true },
      }}
    />,
  );
  await screen.findByLabelText('Tier 1 name');
  const eu = screen.getByRole('button', {
    name: 'EU provider',
  }) as HTMLButtonElement;
  expect(eu.disabled).toBe(true);
  expect(eu.textContent).toContain('Inactive');
  const slider = screen.getByRole('slider', {
    name: 'Privacy boundary',
  }) as HTMLInputElement;
  fireEvent.click(eu);
  expect(slider.value).toBe('4');
  fireEvent.change(slider, { target: { value: '3' } });
  expect(slider.value).toBe('0');
  fireEvent.change(slider, { target: { value: '1' } });
  expect(slider.value).toBe('4');
});
it('an active Mistral language model makes the EU-provider level selectable', async () => {
  renderWithProviders(
    <RoutingConfiguration
      models={[
        {
          id: 'mistral/mistral-large',
          provider: 'mistral',
          zone: 'eu-provider',
        } as ChatModel,
      ]}
      providerStatus={{ mistral: { kind: 'remote', reachable: true } }}
    />,
  );
  await screen.findByLabelText('Tier 1 name');
  expect(
    (
      screen.getByRole('button', {
        name: 'EU provider',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'EU provider' }));
  expect(
    (
      screen.getByRole('slider', {
        name: 'Privacy boundary',
      }) as HTMLInputElement
    ).value,
  ).toBe('2');
});
