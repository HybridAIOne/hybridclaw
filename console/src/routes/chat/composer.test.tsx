import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCommandsResponse, MediaItem } from '../../api/chat-types';
import { Composer } from './composer';

const fetchChatCommandsMock =
  vi.fn<(token: string, query?: string) => Promise<ChatCommandsResponse>>();

vi.mock('../../api/chat', () => ({
  fetchChatCommands: (token: string, query?: string) =>
    fetchChatCommandsMock(token, query),
}));

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
});
