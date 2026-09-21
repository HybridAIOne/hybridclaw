import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AdminConfig } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { RoutingVisibility } from './routing-visibility';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock('../api/client', () => ({
  fetchConfig: mocks.fetch,
  saveConfig: mocks.save,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({
    config: {
      routing: { enabled: true, showRoutingInfo: false },
    } as unknown as AdminConfig,
  });
  mocks.save.mockImplementation((_token, config) =>
    Promise.resolve({ config }),
  );
});
it('saves the visibility switch while preserving routing policy', async () => {
  renderWithProviders(<RoutingVisibility />);
  const toggle = await screen.findByRole('switch', {
    name: 'Show routing tags in chat',
  });
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      routing: { enabled: true, showRoutingInfo: true },
    }),
  );
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});
it('retains the previous setting if saving fails', async () => {
  mocks.save.mockRejectedValueOnce(new Error('Save rejected'));
  renderWithProviders(<RoutingVisibility />);
  const toggle = await screen.findByRole('switch', {
    name: 'Show routing tags in chat',
  });
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  await waitFor(() =>
    expect(toggle.getAttribute('aria-checked')).toBe('false'),
  );
});
