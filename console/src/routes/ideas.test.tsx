import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../lib/chat-helpers', () => ({
  readStoredUserId: () => 'user_a',
}));

vi.mock('./chat-surface-page', () => ({
  ChatSurfacePage: (props: { actions?: ReactNode; children: ReactNode }) => (
    <div>
      {props.actions}
      {props.children}
    </div>
  ),
}));

const IDEA = { title: 'Weekly digest', description: 'Why', prompt: 'Draft it' };
const CACHE_KEY = 'hybridclaw.chat-ideas.v1:user_a:writer';

function ideasResponse(title: string) {
  return {
    agentId: 'writer',
    ideas: [{ ...IDEA, title }],
    generatedAt: new Date().toISOString(),
  };
}

describe('IdeasPage', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchChatIdeasMock.mockReset();
    fetchAgentListMock.mockReset();
    navigateMock.mockClear();
    fetchAgentListMock.mockResolvedValue([
      { id: 'main', name: 'Main' },
      { id: 'writer', name: 'Writer' },
      { id: 'far', name: 'Far', source: { type: 'remote' } },
    ]);
    fetchChatIdeasMock.mockResolvedValue(ideasResponse('Weekly digest'));
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('loads ideas for the linked agent and prefills chat on pick', async () => {
    renderWithProviders(<IdeasPage />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Weekly digest/ }),
    );

    expect(fetchChatIdeasMock).toHaveBeenCalledWith(
      'test-token',
      'user_a',
      'writer',
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/chat',
      search: { prompt: 'Draft it', agent: 'writer' },
    });
    await screen.findByRole('option', { name: 'Writer' });
    expect(screen.queryByRole('option', { name: 'Far' })).toBeNull();
  });

  it('shows cached ideas without a model call and replaces them on refresh', async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify(ideasResponse('Cached idea')),
    );
    fetchChatIdeasMock.mockResolvedValue(ideasResponse('Fresh idea'));
    renderWithProviders(<IdeasPage />);

    await screen.findByRole('button', { name: /Cached idea/ });
    expect(fetchChatIdeasMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh ideas' }));

    await screen.findByRole('button', { name: /Fresh idea/ });
    expect(fetchChatIdeasMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CACHE_KEY)).toContain('Fresh idea');
  });

  it('ignores a malformed cache entry and generates', async () => {
    localStorage.setItem(CACHE_KEY, '{"ideas":"nope"}');
    renderWithProviders(<IdeasPage />);

    await screen.findByRole('button', { name: /Weekly digest/ });
    expect(fetchChatIdeasMock).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the first generation fails', async () => {
    fetchChatIdeasMock.mockRejectedValueOnce(new Error('model offline'));
    renderWithProviders(<IdeasPage />);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'model offline',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchChatIdeasMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: /Weekly digest/ });
  });
});
