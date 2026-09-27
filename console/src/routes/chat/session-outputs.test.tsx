import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatArtifact } from '../../api/chat-types';
import type { ChatUiMessage } from './chat-ui-message';
import { collectSessionOutputs, SessionOutputs } from './session-outputs';

const fetchArtifactBlobMock = vi.fn(
  async (_token: string, _path: string) => new Blob(['x']),
);

vi.mock('../../api/chat', () => ({
  fetchAgentAvatarBlob: vi.fn(),
  fetchArtifactBlob: (token: string, path: string) =>
    fetchArtifactBlobMock(token, path),
}));

function message(id: string, artifacts: ChatArtifact[]): ChatUiMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    sessionId: 'session-1',
    artifacts,
  } as ChatUiMessage;
}

describe('collectSessionOutputs', () => {
  it('lists downloadable artifacts newest first, one per path', () => {
    const outputs = collectSessionOutputs([
      message('m1', [
        { path: '/workspace/a.pdf', filename: 'a.pdf' },
        { filename: 'no-path.txt' },
      ]),
      message('m2', [
        { path: '/workspace/b.docx', filename: 'b.docx' },
        { path: '/workspace/a.pdf', filename: 'a.pdf' },
      ]),
    ]);
    expect(outputs.map((artifact) => artifact.path)).toEqual([
      '/workspace/a.pdf',
      '/workspace/b.docx',
    ]);
  });
});

describe('SessionOutputs', () => {
  it('renders nothing without artifacts', () => {
    const { container } = render(
      <SessionOutputs messages={[message('m1', [])]} token="test-token" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('opens the list and downloads a row', async () => {
    render(
      <SessionOutputs
        messages={[
          message('m1', [
            { path: '/workspace/poem.pdf', filename: 'poem.pdf' },
          ]),
        ]}
        token="test-token"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '1 output' }));
    expect(
      screen.getByRole('dialog', { name: 'Outputs' }).textContent,
    ).toContain('PDF');
    fireEvent.click(screen.getByRole('button', { name: /poem\.pdf/ }));
    await waitFor(() =>
      expect(fetchArtifactBlobMock).toHaveBeenCalledWith(
        'test-token',
        '/workspace/poem.pdf',
      ),
    );
  });
});
