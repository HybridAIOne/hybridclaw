import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatArtifact, ChatMessage } from '../../api/chat-types';
import type { ChatUiMessage } from './chat-ui-message';
import { MessageBlock } from './message-block';

const fetchArtifactBlobMock =
  vi.fn<(token: string, artifactPath: string) => Promise<Blob>>();
const fetchAgentAvatarBlobMock =
  vi.fn<(token: string, imageUrl: string) => Promise<Blob>>();
const renderMarkdownMock = vi.fn<(content: string) => string>();

vi.mock('../../api/chat', () => ({
  fetchAgentAvatarBlob: (token: string, imageUrl: string) =>
    fetchAgentAvatarBlobMock(token, imageUrl),
  fetchArtifactBlob: (token: string, artifactPath: string) =>
    fetchArtifactBlobMock(token, artifactPath),
}));

vi.mock('../../lib/markdown', () => ({
  renderMarkdown: (content: string) => renderMarkdownMock(content),
}));

function makeMessage(
  artifacts: ChatArtifact[],
  overrides?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'Artifact output',
    sessionId: 'session-a',
    artifacts,
    replayRequest: null,
    ...overrides,
  };
}

describe('MessageBlock artifacts', () => {
  beforeEach(() => {
    fetchAgentAvatarBlobMock.mockReset();
    fetchArtifactBlobMock.mockReset();
    renderMarkdownMock.mockReset();
    renderMarkdownMock.mockImplementation((content) => `<p>${content}</p>`);
    vi.stubGlobal('fetch', vi.fn());
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:artifact'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders image previews from blob URLs instead of tokenized artifact URLs', async () => {
    fetchArtifactBlobMock.mockResolvedValue(
      new Blob(['image-bytes'], { type: 'image/png' }),
    );

    const { container } = render(
      <MessageBlock
        message={makeMessage([
          {
            path: '/tmp/image.png',
            filename: 'image.png',
            mimeType: 'image/png',
          },
        ])}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    const preview = await screen.findByAltText('image.png');
    expect(preview.getAttribute('src')).toBe('blob:artifact');
    expect(fetchArtifactBlobMock).toHaveBeenCalledWith(
      'test-token',
      '/tmp/image.png',
    );
    expect(
      container.querySelector('[src*="token="], [href*="token="]'),
    ).toBeNull();
  });

  it('renders PDF previews from authenticated blob URLs', async () => {
    fetchArtifactBlobMock.mockResolvedValue(
      new Blob(['pdf-bytes'], { type: 'application/pdf' }),
    );

    const { container } = render(
      <MessageBlock
        message={makeMessage([
          {
            path: '/tmp/report.pdf',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
          },
        ])}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    const preview = await screen.findByTitle('report.pdf preview');
    expect(preview.getAttribute('src')).toBe('blob:artifact');
    expect(fetchArtifactBlobMock).toHaveBeenCalledWith(
      'test-token',
      '/tmp/report.pdf',
    );
    expect(
      container.querySelector('[src*="token="], [href*="token="]'),
    ).toBeNull();
  });

  it('renders assistant avatars through the authenticated blob helper', async () => {
    fetchAgentAvatarBlobMock.mockResolvedValue(
      new Blob(['avatar-bytes'], { type: 'image/jpeg' }),
    );

    const { container } = render(
      <MessageBlock
        message={makeMessage([], {
          assistantPresentation: {
            agentId: 'stephan',
            displayName: 'Stephan',
            imageUrl: '/api/agent-avatar?agentId=stephan',
          },
        })}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(fetchAgentAvatarBlobMock).toHaveBeenCalledWith(
        'test-token',
        '/api/agent-avatar?agentId=stephan',
      ),
    );
    const avatar = container.querySelector('img');
    expect(avatar?.getAttribute('src')).toBe('blob:artifact');
    expect(
      container.querySelector('img[src="/api/agent-avatar?agentId=stephan"]'),
    ).toBeNull();
  });

  it('renders a local thinking placeholder without invoking markdown rendering', () => {
    const thinkingMessage: ChatUiMessage = {
      id: 'thinking-1',
      role: 'thinking',
      content: '',
      sessionId: 'session-a',
    };

    const { container } = render(
      <MessageBlock
        message={thinkingMessage}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    expect(renderMarkdownMock).not.toHaveBeenCalled();
    expect(container.querySelectorAll('span')).toHaveLength(3);
  });

  it('downloads non-preview artifacts through the authenticated blob helper', async () => {
    fetchArtifactBlobMock.mockResolvedValue(
      new Blob(['docx-bytes'], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    render(
      <MessageBlock
        message={makeMessage([
          {
            path: '/tmp/report.docx',
            filename: 'report.docx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        ])}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() =>
      expect(fetchArtifactBlobMock).toHaveBeenCalledWith(
        'test-token',
        '/tmp/report.docx',
      ),
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('throttles markdown parsing while an assistant message is streaming', async () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <MessageBlock
        message={makeMessage([], { content: 'A' })}
        token="test-token"
        isStreaming
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    expect(renderMarkdownMock).toHaveBeenCalledTimes(1);
    expect(renderMarkdownMock).toHaveBeenLastCalledWith('A');

    rerender(
      <MessageBlock
        message={makeMessage([], { content: 'AB' })}
        token="test-token"
        isStreaming
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );
    rerender(
      <MessageBlock
        message={makeMessage([], { content: 'ABC' })}
        token="test-token"
        isStreaming
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    expect(renderMarkdownMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(renderMarkdownMock).toHaveBeenCalledTimes(2);
    expect(renderMarkdownMock).toHaveBeenLastCalledWith('ABC');

    rerender(
      <MessageBlock
        message={makeMessage([], { content: 'ABCD' })}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    expect(renderMarkdownMock).toHaveBeenCalledTimes(3);
    expect(renderMarkdownMock).toHaveBeenLastCalledWith('ABCD');
  });
});
