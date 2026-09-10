/**
 * Teams user controls reflect persisted mappings and report failed saves.
 * API fixtures isolate the UI contract; transport authorization is tested elsewhere.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMSTeamsUser } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { TeamsUsers } from './teams-users';

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  agents: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../auth', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../api/client', () => ({
  fetchMSTeamsUsers: mocks.users,
  fetchAdminAgents: mocks.agents,
  saveMSTeamsUserAgent: mocks.save,
}));
const user: AdminMSTeamsUser = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  entraObjectId: 'user-a',
  teamsUserId: '29:user-a',
  displayName: 'Example User',
  agentId: null,
  messageCount: 12,
  sessionCount: 2,
  totalTokens: 1234,
  costUsd: 0.125,
  firstSeen: '2026-09-10T09:00:00Z',
  lastSeen: '2026-09-10T10:00:00Z',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.users.mockResolvedValue({ users: [user] });
  mocks.agents.mockResolvedValue([
    { id: 'sales', name: 'Sales' },
    { id: 'archived', name: 'Archived', archived: true },
  ]);
  mocks.save.mockImplementation((_token, _userId, agentId) =>
    Promise.resolve({ users: [{ ...user, agentId }] }),
  );
});

describe('Teams user administration', () => {
  it('shows both IDs and usage, assigns an agent, and removes the mapping', async () => {
    renderWithProviders(<TeamsUsers />);
    expect(await screen.findByText('Example User')).toBeTruthy();
    expect(screen.getByText('Entra: user-a')).toBeTruthy();
    expect(screen.getByText('Teams: 29:user-a')).toBeTruthy();
    expect(screen.getByText('$0.1250')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Archived' })).toBeNull();
    const select = screen.getByLabelText('Agent for Example User');
    fireEvent.change(select, { target: { value: 'sales' } });
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith('test-token', 'user-a', 'sales'),
    );
    await waitFor(() =>
      expect((select as HTMLSelectElement).value).toBe('sales'),
    );
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() =>
      expect(mocks.save).toHaveBeenLastCalledWith('test-token', 'user-a', null),
    );
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(''));
  });

  it('searches by identity and refreshes usage', async () => {
    renderWithProviders(<TeamsUsers />);
    await screen.findByText('Example User');
    fireEvent.change(screen.getByLabelText('Search Teams users'), {
      target: { value: 'unknown' },
    });
    expect(screen.getByText('No matching Teams users.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search Teams users'), {
      target: { value: '29:USER-A' },
    });
    expect(screen.getByText('Example User')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh users' }));
    await waitFor(() => expect(mocks.users).toHaveBeenCalledTimes(2));
  });

  it('retains the saved mapping when an update fails', async () => {
    mocks.users.mockResolvedValue({ users: [{ ...user, agentId: 'deleted' }] });
    mocks.save.mockRejectedValue(new Error('Update rejected'));
    renderWithProviders(<TeamsUsers />);
    const select = await screen.findByLabelText('Agent for Example User');
    expect(
      screen.getByRole('option', { name: 'Unavailable: deleted' }),
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: 'sales' } });
    expect(
      await screen.findByText('Mapping failed: Update rejected'),
    ).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe('deleted');
  });

  it('shows empty and loading-error states without inventing usage', async () => {
    mocks.users.mockResolvedValue({ users: [] });
    const first = renderWithProviders(<TeamsUsers />);
    expect(
      await screen.findByText('No Teams bot users recorded yet.'),
    ).toBeTruthy();
    first.unmount();
    mocks.users.mockRejectedValue(new Error('Unavailable'));
    renderWithProviders(<TeamsUsers />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load Teams users: Unavailable',
    );
  });
});
