import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { RoutingComparison } from './routing-comparison';

const request = vi.hoisted(() => vi.fn());
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../api/client', () => ({
  fetchModels: () => Promise.resolve({ models: [{ id: 'test-router' }] }),
  requestJson: request,
}));
it('requires public approval and shows both classifier costs', async () => {
  request.mockResolvedValue({
    jev: {
      model: 'jev-test',
      recommendedTier: 'economy',
      durationMs: 30,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.0000042,
    },
    concierge: {
      model: 'test-router',
      decision: 'ask-user',
      selectedModel: null,
      tier: null,
      durationMs: 400,
      inputTokens: 200,
      outputTokens: 10,
      costUsd: 0.0001,
    },
  });
  renderWithProviders(<RoutingComparison />);
  await screen.findByRole('option', { name: 'test-router' });
  fireEvent.change(screen.getByLabelText('Concierge model'), {
    target: { value: 'test-router' },
  });
  const button = screen.getByRole('button', {
    name: 'Compare',
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(button);
  await waitFor(() =>
    expect(screen.getByText('Est. $0.00000420')).toBeDefined(),
  );
  expect(screen.getByText('Est. $0.00010000')).toBeDefined();
  expect(request).toHaveBeenCalledWith(
    '/api/admin/routing/compare',
    expect.objectContaining({
      body: {
        text: 'Explain photosynthesis in three sentences.',
        model: 'test-router',
        publicSample: true,
      },
    }),
  );
  fireEvent.change(screen.getByLabelText('Shared prompt'), {
    target: { value: 'Another public sample' },
  });
  expect(button.disabled).toBe(true);
});
