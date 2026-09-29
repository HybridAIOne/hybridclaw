import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { LocalClassifiers } from './local-classifiers';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api/client', () => ({ requestJson: mocks.request }));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
beforeEach(() => vi.clearAllMocks());
it.each([
  ['stopped', false, 'Download & set up decision model', 'setup'],
  ['stopped', true, 'Start decision model', 'start'],
  ['running', true, 'Stop decision model', 'stop'],
  ['starting', true, 'Cancel', 'stop'],
] as const)(
  'controls a %s decision process independently',
  async (status, installed, label, action) => {
    mocks.request.mockResolvedValue({
      classifiers: [
        {
          model: 'local-decision/laya',
          label: 'Laya',
          supported: true,
          status,
          installed,
        },
      ],
    });
    renderWithProviders(<LocalClassifiers />);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        '/api/admin/local-classifiers',
        expect.objectContaining({
          method: 'POST',
          body: { model: 'local-decision/laya', action },
        }),
      ),
    );
  },
);
it('links to optional plugin installation when absent', async () => {
  mocks.request.mockResolvedValue({ classifiers: [] });
  renderWithProviders(<LocalClassifiers />);
  expect(
    (await screen.findByRole('link', { name: 'Plugins' })).getAttribute('href'),
  ).toBe('/admin/extensions?tab=plugins');
});

it.each([
  ['setup', 'Preparing runtime', 0],
  ['downloading', 'Downloading model', 1],
  ['starting', 'Loading model', 2],
] as const)(
  'shows the active phase for %s without a duplicate setup action',
  async (status, label, step) => {
    mocks.request.mockResolvedValue({
      classifiers: [
        {
          model: 'local-decision/laya',
          label: 'Laya',
          supported: true,
          status,
          installed: false,
        },
      ],
    });
    renderWithProviders(<LocalClassifiers />);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(label),
    );
    const steps = screen.getAllByRole('listitem');
    expect(steps[step].getAttribute('aria-current')).toBe('step');
    expect(
      steps.filter((item) => item.getAttribute('data-complete') === 'true'),
    ).toHaveLength(step);
    expect(
      screen.queryByRole('button', { name: /Download & set up/ }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  },
);
