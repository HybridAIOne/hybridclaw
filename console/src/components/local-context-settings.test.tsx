import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  AdminLocalContextSettings,
  AdminLocalContextSettingsUpdate,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import {
  LocalContextControls,
  LocalContextProvider,
  LocalContextStar,
} from './local-context-settings';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock('../api/client', () => ({
  fetchLocalContextSettings: mocks.fetch,
  saveLocalContextSettings: mocks.save,
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-key' }) }));
let stored: AdminLocalContextSettings;
beforeEach(() => {
  vi.clearAllMocks();
  stored = {
    instance: { mode: 'starred', starred: ['read'] },
    agents: [{ id: 'worker', name: 'Worker', mode: null, starred: null }],
    disabled: ['bash'],
  };
  mocks.fetch.mockImplementation(async () => structuredClone(stored));
  mocks.save.mockImplementation(
    async (
      _token: string,
      _kind: string,
      input: AdminLocalContextSettingsUpdate,
    ) => {
      if (input.agentId)
        Object.assign(stored.agents[0], {
          mode: input.mode,
          starred: input.starred,
        });
      else
        stored.instance = {
          mode: input.mode as 'full' | 'starred',
          starred: input.starred as string[],
        };
      return structuredClone(stored);
    },
  );
});
function renderControls(kind: 'tools' | 'skills') {
  return renderWithProviders(
    <LocalContextProvider kind={kind}>
      <LocalContextControls />
      <LocalContextStar name="read" />
      <LocalContextStar name="write" />
      <LocalContextStar name="blocked" unavailable />
    </LocalContextProvider>,
  );
}

test.each(['tools', 'skills'] as const)(
  'saves %s stars and full mode for the instance',
  async (kind) => {
    renderControls(kind);
    await screen.findByText('1/9 starred');
    fireEvent.click(
      screen.getByRole('button', { name: 'Star write in catalog' }),
    );
    await screen.findByText('2/9 starred');
    expect(mocks.save).toHaveBeenLastCalledWith('test-key', kind, {
      agentId: null,
      mode: 'starred',
      starred: ['read', 'write'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenLastCalledWith('test-key', kind, {
        agentId: null,
        mode: 'full',
        starred: ['read', 'write'],
      }),
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Star blocked in catalog',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);

test.each(['tools', 'skills'] as const)(
  'creates an independent %s agent override and restores inheritance',
  async (kind) => {
    renderControls(kind);
    await screen.findByText('1/9 starred');
    fireEvent.change(
      screen.getByRole('combobox', { name: `Local ${kind} scope` }),
      { target: { value: 'worker' } },
    );
    expect(screen.getByText('Using instance default')).toBeDefined();
    fireEvent.click(
      screen.getByRole('button', { name: 'Unstar read in catalog' }),
    );
    await screen.findByText('0/9 starred');
    expect(mocks.save).toHaveBeenLastCalledWith('test-key', kind, {
      agentId: 'worker',
      mode: 'starred',
      starred: [],
    });
    expect(stored.instance.starred).toEqual(['read']);
    fireEvent.click(
      screen.getByRole('button', { name: 'Use instance default' }),
    );
    await screen.findByText('1/9 starred');
    expect(mocks.save).toHaveBeenLastCalledWith('test-key', kind, {
      agentId: 'worker',
      mode: null,
      starred: null,
    });
  },
);

test('keeps saved stars visible after a failed save', async () => {
  mocks.save.mockRejectedValue(new Error('Save rejected'));
  renderControls('tools');
  await screen.findByText('1/9 starred');
  fireEvent.click(
    screen.getByRole('button', { name: 'Star write in catalog' }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Save rejected',
  );
  expect(screen.getByText('1/9 starred')).toBeDefined();
  expect(
    screen
      .getByRole('button', { name: 'Star write in catalog' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
});

test.each(['tools', 'skills'] as const)(
  'caps %s at nine but lets a user remove an unlisted star',
  async (kind) => {
    stored.instance.starred = [
      'read',
      ...Array.from({ length: 8 }, (_, i) => `unlisted${i}`),
    ];
    renderControls(kind);
    await screen.findByText('9/9 starred');
    expect(
      (
        screen.getByRole('button', {
          name: 'Star write in catalog',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unstar unlisted0' }));
    await screen.findByText('8/9 starred');
    expect(
      (
        screen.getByRole('button', {
          name: 'Star write in catalog',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  },
);
