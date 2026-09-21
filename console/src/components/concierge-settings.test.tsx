import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { ConciergeSettings } from './concierge-settings';

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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({
    config: {
      routing: {
        enabled: true,
        concierge: {
          enabled: false,
          model: 'test-model',
          profiles: {
            asap: 'test-fast',
            balanced: 'test-mid',
            noHurry: 'test-slow',
          },
        },
      },
    },
  });
  mocks.save.mockImplementation((_token, config) =>
    Promise.resolve({ config }),
  );
  mocks.request.mockResolvedValue({ jevAvailable: false });
});
it('disables JEV when credentials are absent', async () => {
  renderWithProviders(<ConciergeSettings models={[]} />);
  await screen.findByLabelText('Concierge model');
  const option = screen.getByRole('option', {
    name: /JEV · Typed routing/,
  }) as HTMLOptionElement;
  await waitFor(() =>
    expect(option.textContent).toContain('JEV_API_KEY required'),
  );
  expect(option.disabled).toBe(true);
});
it('selects JEV as the concierge while preserving tier configuration', async () => {
  mocks.request.mockResolvedValue({ jevAvailable: true });
  renderWithProviders(<ConciergeSettings models={[]} />);
  const select = await screen.findByLabelText('Concierge model');
  await waitFor(() =>
    expect(
      (
        screen.getByRole('option', {
          name: 'JEV · Typed routing',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.change(select, { target: { value: 'jev/jev-latest' } });
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'Save concierge' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-token', {
      routing: {
        enabled: true,
        concierge: {
          enabled: true,
          model: 'jev/jev-latest',
          profiles: {
            asap: 'test-fast',
            balanced: 'test-mid',
            noHurry: 'test-slow',
          },
        },
      },
    }),
  );
});
