import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatCommandSuggestion,
  ChatCommandsResponse,
  MediaItem,
} from '../../api/chat-types';
import { Composer } from './composer';

const fetchChatCommandsMock =
  vi.fn<(token: string, query?: string) => Promise<ChatCommandsResponse>>();

vi.mock('../../api/chat', () => ({
  fetchChatCommands: (token: string, query?: string) =>
    fetchChatCommandsMock(token, query),
}));

const APPROVE: ChatCommandSuggestion = {
  id: 'approve',
  label: '/approve [action]',
  insertText: '/approve ',
  description: 'Approve a pending action',
};

const CLEAR: ChatCommandSuggestion = {
  id: 'clear',
  label: '/clear',
  insertText: '/clear',
  description: 'Clear the session',
};

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
) {
  return render(
    <Composer
      isStreaming={false}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onUploadFiles={vi.fn<(_: File[]) => Promise<MediaItem[]>>()}
      token="test-token"
      {...overrides}
    />,
  );
}

describe('Composer', () => {
  beforeEach(() => {
    fetchChatCommandsMock.mockReset();
  });

  it('strips the leading slash before fetching command suggestions', async () => {
    fetchChatCommandsMock.mockResolvedValue({
      commands: [],
    });

    render(
      <Composer
        isStreaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onUploadFiles={vi.fn<(_: File[]) => Promise<MediaItem[]>>()}
        token="test-token"
      />,
    );

    fireEvent.input(screen.getByLabelText('Message input'), {
      target: { value: '/approve' },
    });

    await waitFor(() =>
      expect(fetchChatCommandsMock).toHaveBeenCalledWith(
        'test-token',
        'approve',
      ),
    );
  });

  it('renders a compact agent switcher beside the attach button', () => {
    const onAgentSwitch = vi.fn();

    render(
      <Composer
        isStreaming={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onUploadFiles={vi.fn<(_: File[]) => Promise<MediaItem[]>>()}
        token="test-token"
        agents={[
          { id: 'main', name: 'Assistant' },
          { id: 'charly', name: 'Charly' },
        ]}
        selectedAgentId="main"
        onAgentSwitch={onAgentSwitch}
      />,
    );

    fireEvent.change(screen.getByLabelText('Switch agent'), {
      target: { value: 'charly' },
    });

    expect(onAgentSwitch).toHaveBeenCalledWith('charly');
  });

  describe('slash command suggestion panel', () => {
    async function showPanel(
      commands: ChatCommandSuggestion[],
      typed = '/',
    ): Promise<HTMLTextAreaElement> {
      fetchChatCommandsMock.mockResolvedValue({ commands });
      renderComposer();
      const textarea = screen.getByLabelText(
        'Message input',
      ) as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: typed } });
      await screen.findByRole('listbox');
      return textarea;
    }

    it('inserts insertText with exactly one trailing space (no double space)', async () => {
      const textarea = await showPanel([APPROVE]);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(textarea.value).toBe('/approve ');
    });

    it('appends a single trailing space when insertText has none', async () => {
      const textarea = await showPanel([CLEAR]);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(textarea.value).toBe('/clear ');
    });

    it('Tab also accepts the active suggestion', async () => {
      const textarea = await showPanel([APPROVE]);
      fireEvent.keyDown(textarea, { key: 'Tab' });
      expect(textarea.value).toBe('/approve ');
    });

    it('ArrowDown moves selection and wraps around', async () => {
      const textarea = await showPanel([APPROVE, CLEAR]);
      const initial = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('aria-selected'));
      expect(initial).toEqual(['true', 'false']);

      fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      const afterDown = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('aria-selected'));
      expect(afterDown).toEqual(['false', 'true']);

      fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      const wrapped = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('aria-selected'));
      expect(wrapped).toEqual(['true', 'false']);
    });

    it('ArrowUp from the first item wraps to the last', async () => {
      const textarea = await showPanel([APPROVE, CLEAR]);
      fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      const wrapped = screen
        .getAllByRole('option')
        .map((el) => el.getAttribute('aria-selected'));
      expect(wrapped).toEqual(['false', 'true']);
    });

    it('Escape closes the panel', async () => {
      const textarea = await showPanel([APPROVE]);
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('mouseDown on a suggestion item applies it', async () => {
      const textarea = await showPanel([APPROVE, CLEAR]);
      fireEvent.mouseDown(screen.getByText('/clear'));
      expect(textarea.value).toBe('/clear ');
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('clicking outside the composer closes the panel', async () => {
      await showPanel([APPROVE]);
      fireEvent.mouseDown(document.body);
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    });

    it('typing a non-slash character hides the panel', async () => {
      const textarea = await showPanel([APPROVE]);
      fireEvent.input(textarea, { target: { value: 'hello' } });
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('does not render an empty panel when the API returns no commands', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [] });
      renderComposer();
      const textarea = screen.getByLabelText(
        'Message input',
      ) as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: '/zzz' } });
      await waitFor(() =>
        expect(fetchChatCommandsMock).toHaveBeenCalledWith(
          'test-token',
          'zzz',
        ),
      );
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });
});
