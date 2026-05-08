import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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

const getTextarea = () =>
  screen.getByLabelText('Message input') as HTMLTextAreaElement;

describe('Composer', () => {
  beforeEach(() => {
    fetchChatCommandsMock.mockReset();
  });

  it('strips the leading slash before fetching command suggestions', async () => {
    fetchChatCommandsMock.mockResolvedValue({ commands: [] });
    renderComposer();
    fireEvent.input(getTextarea(), { target: { value: '/approve' } });
    await waitFor(() =>
      expect(fetchChatCommandsMock).toHaveBeenCalledWith(
        'test-token',
        'approve',
      ),
    );
  });

  it('renders a compact agent switcher beside the attach button', () => {
    const onAgentSwitch = vi.fn();
    renderComposer({
      agents: [
        { id: 'main', name: 'Assistant' },
        { id: 'charly', name: 'Charly' },
      ],
      selectedAgentId: 'main',
      onAgentSwitch,
    });
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
      const textarea = getTextarea();
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

    it('shows a no-match empty state when a non-empty query returns nothing', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [] });
      renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/zzz' } });
      const panel = await screen.findByRole('listbox');
      expect(panel.textContent).toMatch(/No commands match/i);
      expect(panel.textContent).toContain('/zzz');
      expect(screen.queryByRole('option')).toBeNull();
    });

    it('keeps the panel closed when the bare slash returns no results', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [] });
      renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/' } });
      await waitFor(() =>
        expect(fetchChatCommandsMock).toHaveBeenCalledWith(
          'test-token',
          undefined,
        ),
      );
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('Enter on empty state sends the message instead of selecting', async () => {
      const onSend = vi.fn();
      fetchChatCommandsMock.mockResolvedValue({ commands: [] });
      renderComposer({ onSend });
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/zzz' } });
      await screen.findByRole('listbox');
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledWith('/zzz', []);
    });

    it('hovering a suggestion item syncs the active index', async () => {
      await showPanel([APPROVE, CLEAR]);
      const items = screen.getAllByRole('option');
      fireEvent.mouseEnter(items[1]);
      const after = items.map((el) => el.getAttribute('aria-selected'));
      expect(after).toEqual(['false', 'true']);
    });

    it('Home and End jump to the first / last suggestion', async () => {
      const textarea = await showPanel([
        APPROVE,
        CLEAR,
        { ...APPROVE, id: 'approve-yes', label: '/approve yes' },
      ]);
      fireEvent.keyDown(textarea, { key: 'End' });
      expect(
        screen
          .getAllByRole('option')
          .map((el) => el.getAttribute('aria-selected')),
      ).toEqual(['false', 'false', 'true']);
      fireEvent.keyDown(textarea, { key: 'Home' });
      expect(
        screen
          .getAllByRole('option')
          .map((el) => el.getAttribute('aria-selected')),
      ).toEqual(['true', 'false', 'false']);
    });

    it('wires combobox aria attributes between the textarea and the listbox', async () => {
      const textarea = await showPanel([APPROVE, CLEAR]);
      const listbox = screen.getByRole('listbox');
      const listboxId = listbox.getAttribute('id');
      expect(listboxId).toBeTruthy();
      expect(textarea.getAttribute('role')).toBe('combobox');
      expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
      expect(textarea.getAttribute('aria-haspopup')).toBe('listbox');
      expect(textarea.getAttribute('aria-controls')).toBe(listboxId);
      expect(textarea.getAttribute('aria-expanded')).toBe('true');
      const activeId = textarea.getAttribute('aria-activedescendant');
      expect(activeId).toBeTruthy();
      expect(document.getElementById(activeId ?? '')).toBe(
        screen.getAllByRole('option')[0],
      );

      fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      const after = textarea.getAttribute('aria-activedescendant');
      expect(document.getElementById(after ?? '')).toBe(
        screen.getAllByRole('option')[1],
      );
    });

    it('clears aria-expanded and aria-activedescendant when the panel closes', async () => {
      const textarea = await showPanel([APPROVE]);
      expect(textarea.getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(textarea.getAttribute('aria-expanded')).toBe('false');
      expect(textarea.getAttribute('aria-activedescendant')).toBeNull();
    });

    it('marks subcommand items (depth >= 2) with the indented class', async () => {
      const sub: ChatCommandSuggestion = {
        id: 'agent.info',
        label: '/agent info',
        insertText: '/agent info',
        description: 'Inspect agent',
        depth: 2,
      };
      await showPanel([APPROVE, sub]);
      const items = screen.getAllByRole('option');
      expect(items[0].className).not.toMatch(/Sub/);
      expect(items[1].className).toMatch(/Sub/);
    });

    it('keeps the panel open as the user types subcommand text after a space', async () => {
      fetchChatCommandsMock.mockResolvedValue({
        commands: [
          {
            ...APPROVE,
            id: 'agent.info',
            label: '/agent info',
            insertText: '/agent info',
          },
        ],
      });
      renderComposer();
      const textarea = getTextarea();
      textarea.value = '/agent';
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      fireEvent.input(textarea);
      await screen.findByRole('listbox');
      textarea.value = '/agent ';
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      fireEvent.input(textarea);
      await waitFor(() =>
        expect(fetchChatCommandsMock).toHaveBeenLastCalledWith(
          'test-token',
          'agent',
        ),
      );
      expect(screen.queryByRole('listbox')).not.toBeNull();
      textarea.value = '/agent in';
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      fireEvent.input(textarea);
      await waitFor(() =>
        expect(fetchChatCommandsMock).toHaveBeenLastCalledWith(
          'test-token',
          'agent in',
        ),
      );
      expect(screen.queryByRole('listbox')).not.toBeNull();
    });

    it('opens for slash tokens that follow a space (mid-line)', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [APPROVE] });
      renderComposer();
      const textarea = getTextarea();
      textarea.value = 'hello /app';
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      fireEvent.input(textarea);
      await screen.findByRole('listbox');
      await waitFor(() =>
        expect(fetchChatCommandsMock).toHaveBeenLastCalledWith(
          'test-token',
          'app',
        ),
      );
    });

    it('replaces only the slash token when accepting mid-line', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [APPROVE] });
      renderComposer();
      const textarea = getTextarea();
      textarea.value = 'hello /app world';
      const cursor = 'hello /app'.length;
      textarea.setSelectionRange(cursor, cursor);
      fireEvent.input(textarea);
      await screen.findByRole('listbox');
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(textarea.value).toBe('hello /approve world');
      expect(textarea.selectionStart).toBe('hello /approve'.length);
    });

    it('highlights the matching substring of the label with <mark>', async () => {
      const cfg: ChatCommandSuggestion = {
        id: 'config',
        label: '/config get',
        insertText: '/config get',
        description: 'Get a config value',
      };
      fetchChatCommandsMock.mockResolvedValue({ commands: [cfg] });
      renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/conf' } });
      const panel = await screen.findByRole('listbox');
      const mark = panel.querySelector('mark');
      expect(mark).not.toBeNull();
      expect(mark?.textContent).toBe('conf');
    });

    it('renders <...> and [...] placeholders in monospace style', async () => {
      const item: ChatCommandSuggestion = {
        id: 'channel-mode',
        label: '/channel-mode <off|mention|free>',
        insertText: '/channel-mode ',
        description: 'Set channel mode',
      };
      await showPanel([item]);
      // The placeholder must render as its own discrete element (a mono-styled
      // span) — getByText only matches when the text is a single text node.
      expect(screen.getByText('<off|mention|free>')).toBeTruthy();
    });

    it('updates the polite live region with the result count', async () => {
      fetchChatCommandsMock.mockResolvedValue({
        commands: [
          APPROVE,
          CLEAR,
          { ...APPROVE, id: 'approve-yes', label: '/approve yes' },
        ],
      });
      const { container } = renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/' } });
      await screen.findByRole('listbox');
      const live = container.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toBe('3 commands available');
    });

    it('announces the empty state to the live region', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [] });
      const { container } = renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/zzz' } });
      await screen.findByRole('listbox');
      const live = container.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toBe('No commands match /zzz');
    });

    it('uses singular grammar for a single match', async () => {
      fetchChatCommandsMock.mockResolvedValue({ commands: [APPROVE] });
      const { container } = renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/' } });
      await screen.findByRole('listbox');
      const live = container.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toBe('1 command available');
    });

    it('a stale fetch resolving after dismiss does not reopen the panel', async () => {
      let resolveFetch: ((value: ChatCommandsResponse) => void) | undefined;
      fetchChatCommandsMock.mockImplementation(
        () =>
          new Promise<ChatCommandsResponse>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      renderComposer();
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/' } });
      await waitFor(() => expect(fetchChatCommandsMock).toHaveBeenCalled());
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      await act(async () => {
        resolveFetch?.({ commands: [APPROVE] });
      });
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('submit cancels a pending lookup so a late response does not pop the panel', async () => {
      let resolveFetch: ((value: ChatCommandsResponse) => void) | undefined;
      fetchChatCommandsMock.mockImplementation(
        () =>
          new Promise<ChatCommandsResponse>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const onSend = vi.fn();
      renderComposer({ onSend });
      const textarea = getTextarea();
      fireEvent.input(textarea, { target: { value: '/test' } });
      await waitFor(() => expect(fetchChatCommandsMock).toHaveBeenCalled());
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).toHaveBeenCalledWith('/test', []);
      await act(async () => {
        resolveFetch?.({ commands: [APPROVE] });
      });
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });
});
