import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAgent } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { AgentsHubPage } from './agents-hub';

const fetchAdminAgentsMock = vi.fn<() => Promise<AdminAgent[]>>();
const updateAdminAgentMock = vi.fn();
const useAuthMock = vi.fn();
const navigateMock = vi.fn(() => Promise.resolve());

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => ({ tab: 'scoreboard' }),
}));

vi.mock('../api/client', () => ({
  fetchAdminAgents: () => fetchAdminAgentsMock(),
  updateAdminAgent: (...args: unknown[]) => updateAdminAgentMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('./agent-scoreboard', () => ({
  AgentsPage: () => <div>Scoreboard content</div>,
}));

vi.mock('./agents', () => ({
  AgentFilesPage: () => <div>Workspace files content</div>,
}));

function makeAgent(id: string, name: string, archived = false): AdminAgent {
  return {
    id,
    archived,
    name,
    model: null,
    skills: null,
    chatbotId: null,
    enableRag: null,
    role: null,
    reportsTo: null,
    delegatesTo: null,
    peers: null,
    workspace: null,
    workspacePath: `/tmp/${id}/workspace`,
    markdownFiles: [],
  };
}

describe('AgentsHubPage', () => {
  beforeEach(() => {
    fetchAdminAgentsMock.mockReset();
    updateAdminAgentMock.mockReset();
    useAuthMock.mockReset();
    navigateMock.mockClear();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchAdminAgentsMock.mockResolvedValue([
      makeAgent('main', 'Main Agent'),
      makeAgent('writer', 'Writer'),
      makeAgent('retired', 'Retired', true),
    ]);
    updateAdminAgentMock.mockResolvedValue(makeAgent('writer', 'Writer', true));
  });

  it('hides archived agents from selectors and archives non-default agents', async () => {
    renderWithProviders(<AgentsHubPage />);

    const selector = await screen.findByRole('combobox', { name: 'Agent' });
    await waitFor(() => {
      expect(selector.textContent).toContain('Main Agent (main)');
      expect(selector.textContent).toContain('Writer (writer)');
      expect(selector.textContent).not.toContain('Retired');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Archive agents' }));
    expect(screen.queryByRole('checkbox', { name: /Main Agent/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Writer/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'writer',
        { archived: true },
      );
    });
  });

  it('restores archived agents from the archive dialog', async () => {
    updateAdminAgentMock.mockResolvedValue(
      makeAgent('retired', 'Retired', false),
    );
    renderWithProviders(<AgentsHubPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Archive agents' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(updateAdminAgentMock).toHaveBeenCalledWith(
        'test-token',
        'retired',
        { archived: false },
      );
    });
  });
});
