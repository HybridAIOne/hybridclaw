/**
 * Catalog filter coverage uses synthetic settings and tool inventory.
 * Display selection must follow stars without saving exposure or permissions.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  AdminLocalContextSettings,
  AdminLocalContextSettingsUpdate,
  AdminToolsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { ToolsPage } from './tools';

const mocks = vi.hoisted(() => ({
  tools: vi.fn(),
  settings: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../api/client', () => ({
  fetchTools: mocks.tools,
  fetchLocalContextSettings: mocks.settings,
  saveLocalContextSettings: mocks.save,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-key' }) }));
let settings: AdminLocalContextSettings;
beforeEach(() => {
  vi.clearAllMocks();
  settings = {
    instance: { mode: 'starred', starred: ['read', 'bash'] },
    agents: [{ id: 'worker', name: 'Worker', mode: null, starred: ['write'] }],
    disabled: ['bash'],
  };
  const tools: AdminToolsResponse = {
    totals: {
      totalTools: 3,
      builtinTools: 3,
      mcpTools: 0,
      otherTools: 0,
      recentExecutions: 0,
      recentErrors: 0,
    },
    groups: [
      {
        label: 'Files',
        tools: ['read', 'write', 'bash'].map((name) => ({
          name,
          group: 'Files',
          kind: 'builtin',
          recentCalls: 0,
          recentErrors: 0,
          lastUsedAt: null,
          recentErrorSamples: [],
        })),
      },
    ],
    recentExecutions: [],
  };
  mocks.tools.mockResolvedValue(tools);
  mocks.settings.mockImplementation(async () => structuredClone(settings));
  mocks.save.mockImplementation(
    async (
      _token: string,
      _kind: string,
      input: AdminLocalContextSettingsUpdate,
    ) => {
      Object.assign(settings.agents[0], {
        mode: input.mode,
        starred: input.starred,
      });
      return structuredClone(settings);
    },
  );
});

test('combines all, active, and starred tool filters with search', async () => {
  renderWithProviders(<ToolsPage />);
  await screen.findByText('3 tools visible');
  await screen.findByText('2/9 starred');
  const selector = screen.getByRole('combobox', { name: 'Show tools' });
  fireEvent.change(selector, { target: { value: 'active' } });
  expect(screen.getByText('2 tools visible')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Unstar bash in catalog' }),
  ).toBeNull();
  fireEvent.change(selector, { target: { value: 'starred' } });
  expect(
    screen.getByRole('button', { name: 'Unstar bash in catalog' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Star write in catalog' }),
  ).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('Filter tools'), {
    target: { value: 'write' },
  });
  await screen.findByText('No tools match this filter.');
  fireEvent.change(selector, { target: { value: 'all' } });
  expect(screen.getByText('1 tool visible')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Star write in catalog' }),
  ).toBeTruthy();
  expect(mocks.save).not.toHaveBeenCalled();
});

test('updates starred rows when the scope or saved stars change', async () => {
  renderWithProviders(<ToolsPage />);
  await screen.findByRole('button', { name: 'Unstar read in catalog' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Show tools' }), {
    target: { value: 'starred' },
  });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Local tools scope' }),
    { target: { value: 'worker' } },
  );
  expect(screen.getByText('1 tool visible')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Unstar read in catalog' }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Unstar write in catalog' }),
  );
  await screen.findByText('No tools match this filter.');
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith('test-key', 'tools', {
      agentId: 'worker',
      mode: 'starred',
      starred: [],
    }),
  );
});

test('keeps all tools accessible if filter settings cannot be loaded', async () => {
  mocks.settings.mockRejectedValue(new Error('Settings unavailable'));
  renderWithProviders(<ToolsPage />);
  await screen.findByText('Settings unavailable');
  expect(screen.getByText('3 tools visible')).toBeTruthy();
  expect(
    (screen.getByRole('option', { name: 'Only active' }) as HTMLOptionElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('option', { name: 'Only starred' }) as HTMLOptionElement)
      .disabled,
  ).toBe(true);
});
