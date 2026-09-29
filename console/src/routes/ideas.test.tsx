import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import { IdeasPage } from './ideas';

const fetchChatIdeasMock = vi.fn();
const fetchAgentListMock = vi.fn();
const navigateMock = vi.fn(() => Promise.resolve());

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => ({ agent: 'Writer' }),
}));

vi.mock('../api/chat', () => ({
  fetchChatIdeas: (...args: unknown[]) => fetchChatIdeasMock(...args),
}));

vi.mock('../api/client', () => ({
  fetchAgentList: () => fetchAgentListMock(),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
  isAuthReadyForApi: () => true,
}));

vi.mock('../components/theme-toggle', () => ({
  ThemeToggle: () => null,
}));

vi.mock('./apps-chat-sidebar', () => ({
  AppsChatSidebar: () => null,
}));

const IDEA = { title: 'Weekly digest', description: 'Why', prompt: 'Draft it' };

describe('IdeasPage', () => {
  beforeEach(() => {
    fetchChatIdeasMock.mockReset();
    fetchAgentListMock.mockReset();
    navigateMock.mockClear();
    fetchAgentListMock.mockResolvedValue([
      { id: 'main', name: 'Main' },
      { id: 'writer', name: 'Writer' },
      { id: 'far', name: 'Far', source: { type: 'remote' } },
    ]);
    fetchChatIdeasMock.mockResolvedValue({ agentId: 'writer', ideas: [IDEA] });
  });

  it('loads ideas for the linked agent and prefills chat on pick', async () => {
    renderWithProviders(<IdeasPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Weekly digest/ }),
    );

    expect(fetchChatIdeasMock).toHaveBeenCalledWith(
      'test-token',
      expect.any(String),
      'writer',
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/chat',
      search: { prompt: 'Draft it', agent: 'writer' },
    });
    await screen.findByRole('option', { name: 'Writer' });
    expect(screen.queryByRole('option', { name: 'Far' })).toBeNull();
  });

  it('regenerates only on an explicit refresh', async () => {
    renderWithProviders(<IdeasPage />);
    await screen.findByRole('button', { name: /Weekly digest/ });

    fireEvent.click(screen.getByRole('button', { name: 'New ideas' }));

    await waitFor(() => expect(fetchChatIdeasMock).toHaveBeenCalledTimes(2));
  });

  it('shows the gateway error', async () => {
    fetchChatIdeasMock.mockRejectedValue(new Error('model offline'));
    renderWithProviders(<IdeasPage />);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'model offline',
    );
  });
});
