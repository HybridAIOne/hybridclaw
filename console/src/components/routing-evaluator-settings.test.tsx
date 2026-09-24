import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTING_EVALUATOR } from '../../../src/routing/evaluator-contract';
import { renderWithProviders } from '../test-utils';
import { RoutingEvaluatorSettings } from './routing-evaluator-settings';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn(),
  request: vi.fn(),
}));
vi.mock('../api/client', () => ({
  fetchConfig: mocks.fetch,
  saveConfig: mocks.save,
  requestJson: mocks.request,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('./secret-ref-picker', () => ({
  CanonicalSecretStatus: () => <span>Credential status</span>,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({
    config: {
      routing: { evaluator: DEFAULT_ROUTING_EVALUATOR, enabled: true },
    },
  });
  mocks.save.mockImplementation((_token, config) =>
    Promise.resolve({ config }),
  );
  mocks.request.mockResolvedValue({
    version: 1,
    provider: 'jev',
    mode: 'shadow',
    status: 'blocked',
    reason: 'public-approval-required',
    model: 'jev-latest',
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    distributions: null,
    recommendedTier: null,
    applied: false,
  });
});
it('requires separate public approval and resets it when the sample changes', async () => {
  renderWithProviders(<RoutingEvaluatorSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Evaluate sample' }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/routing/evaluate',
      expect.objectContaining({
        body: {
          text: 'Explain photosynthesis in three sentences.',
          publicSample: false,
        },
      }),
    ),
  );
  const toggle = screen.getByRole('switch');
  fireEvent.click(toggle);
  fireEvent.change(screen.getByLabelText('Sample text'), {
    target: { value: 'New sample' },
  });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
it('saves evaluator settings without changing routing enablement', async () => {
  renderWithProviders(<RoutingEvaluatorSettings />);
  const mode = screen.getByLabelText('JEV model');
  await waitFor(() => expect(mode.closest('fieldset')?.disabled).toBe(false));
  fireEvent.change(mode, { target: { value: 'jev-test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save evaluator' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      routing: {
        enabled: true,
        evaluator: { ...DEFAULT_ROUTING_EVALUATOR, model: 'jev-test' },
      },
    }),
  );
});
