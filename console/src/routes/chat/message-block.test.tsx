import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatArtifact, ChatMessage } from '../../api/chat-types';
import css from './chat-page.module.css';
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

  it('renders multiline user message bubbles with newline-preserving styling', () => {
    const content = 'first line\nsecond line\nthird line';
    render(
      <MessageBlock
        message={makeMessage([], { role: 'user', content })}
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

    const bubble = screen.getByText(
      (_text, element) => element?.textContent === content,
    );
    expect(bubble.textContent).toBe(content);
    expect(bubble.classList.contains(css.bubbleUser)).toBe(true);
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

  it('renders artifact-only assistant turns without an empty text bubble', async () => {
    fetchArtifactBlobMock.mockResolvedValue(
      new Blob(['image-bytes'], { type: 'image/png' }),
    );

    const { container } = render(
      <MessageBlock
        message={makeMessage(
          [
            {
              path: '/tmp/hybridclaw_io.png',
              filename: 'hybridclaw_io.png',
              mimeType: 'image/png',
            },
          ],
          { content: '' },
        )}
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

    expect(container.querySelector('p')).toBeNull();
    expect(await screen.findByAltText('hybridclaw_io.png')).toBeTruthy();
  });

  it('preserves SVG preview mime type when artifact downloads are forced attachments', async () => {
    fetchArtifactBlobMock.mockResolvedValue(
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], {
        type: 'application/octet-stream',
      }),
    );

    render(
      <MessageBlock
        message={makeMessage([
          {
            path: '/tmp/diagram.svg',
            filename: 'diagram.svg',
            mimeType: 'image/svg+xml',
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

    const preview = await screen.findByAltText('diagram.svg');
    expect(preview.getAttribute('src')).toBe('blob:artifact');
    const [previewBlob] = vi.mocked(URL.createObjectURL).mock.calls[0] ?? [];
    expect(previewBlob).toBeInstanceOf(Blob);
    expect((previewBlob as Blob).type).toBe('image/svg+xml');
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
    expect(preview.getAttribute('sandbox')).toBe('');
    expect(fetchArtifactBlobMock).toHaveBeenCalledWith(
      'test-token',
      '/tmp/report.pdf',
    );
    expect(
      container.querySelector('[src*="token="], [href*="token="]'),
    ).toBeNull();
  });

  it('renders video previews from authenticated blob URLs', async () => {
    fetchArtifactBlobMock.mockResolvedValue(
      new Blob(['video-bytes'], { type: 'application/octet-stream' }),
    );

    const { container } = render(
      <MessageBlock
        message={makeMessage([
          {
            path: '/tmp/demo.mp4',
            filename: 'demo.mp4',
            mimeType: 'video/mp4',
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

    await waitFor(() => {
      expect(
        container.querySelector('video[src="blob:artifact"]'),
      ).toBeTruthy();
    });
    const [previewBlob] = vi.mocked(URL.createObjectURL).mock.calls[0] ?? [];
    expect(previewBlob).toBeInstanceOf(Blob);
    expect((previewBlob as Blob).type).toBe('video/mp4');
    expect(fetchArtifactBlobMock).toHaveBeenCalledWith(
      'test-token',
      '/tmp/demo.mp4',
    );
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

  it('renders accessible response rating controls and clears the selected rating', () => {
    const onRate = vi.fn();
    render(
      <MessageBlock
        message={makeMessage([], {
          messageId: 42,
          responseRating: 'up',
        })}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onRate={onRate}
        ratingBusy={false}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    const up = screen.getByRole('button', {
      name: 'Clear thumbs up rating',
    });
    const down = screen.getByRole('button', {
      name: 'Rate response thumbs down',
    });
    expect(up.getAttribute('aria-pressed')).toBe('true');
    expect(down.getAttribute('aria-pressed')).toBe('false');
    expect(up.getAttribute('data-rating-locked')).toBe('true');
    expect(down.getAttribute('data-rating-locked')).toBe('true');
    expect(up.hasAttribute('disabled')).toBe(false);
    expect(down.hasAttribute('disabled')).toBe(true);
    expect(up.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
    expect(down.querySelector('svg')?.getAttribute('fill')).toBe('none');

    fireEvent.click(up);
    expect(onRate).toHaveBeenCalledWith(expect.any(Object), null);
  });

  it('disables thumbs up after a thumbs down rating is selected', () => {
    render(
      <MessageBlock
        message={makeMessage([], {
          messageId: 42,
          responseRating: 'down',
        })}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onRate={vi.fn()}
        ratingBusy={false}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'Rate response thumbs up' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Clear thumbs down rating' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(
      screen
        .getByRole('button', { name: 'Clear thumbs down rating' })
        .querySelector('svg')
        ?.getAttribute('fill'),
    ).toBe('currentColor');
  });

  it('keeps response rating controls visible but disabled before message persistence', () => {
    render(
      <MessageBlock
        message={makeMessage([], { messageId: null })}
        token="test-token"
        isStreaming={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onRate={vi.fn()}
        ratingBusy={false}
        onApprovalAction={vi.fn()}
        approvalBusy={false}
        branchInfo={null}
        onBranchNav={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: 'Rate response thumbs up' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Rate response thumbs down' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('MessageBlock command vs system output', () => {
  beforeEach(() => {
    renderMarkdownMock.mockReset();
    renderMarkdownMock.mockImplementation((content) => `<p>${content}</p>`);
    fetchAgentAvatarBlobMock.mockReset();
  });

  function renderRole(role: ChatMessage['role'], content: string) {
    return render(
      <MessageBlock
        message={makeMessage([], { role, content })}
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
  }

  it('renders command output as a markdown console block with no assistant label', () => {
    // An assistant reply carries the agent label so it reads as a model turn.
    const assistant = renderRole('assistant', 'A model reply');
    expect(screen.getByText('Assistant')).not.toBeNull();
    assistant.unmount();

    // Command output renders as markdown but has no agent label, so it can't be
    // mistaken for a model reply...
    renderMarkdownMock.mockClear();
    const { container } = renderRole('command', 'Switched model to opus-4-7.');
    expect(screen.queryByText('Assistant')).toBeNull();
    expect(renderMarkdownMock).toHaveBeenCalledWith(
      'Switched model to opus-4-7.',
    );
    expect(screen.getByText('Switched model to opus-4-7.')).not.toBeNull();
    // ...and it carries the distinct terminal-block styling, not the centered
    // system-notice styling.
    expect(container.querySelector('[class*="bubbleCommand"]')).not.toBeNull();
    expect(container.querySelector('[class*="bubbleSystem"]')).toBeNull();
  });

  it('renders a system notice as plain text with the notice styling, not the console block', () => {
    // System messages (e.g. errors) must stay a plain, centered notice — they
    // are not command output, so they are neither markdown-rendered nor given
    // the terminal-block styling.
    renderMarkdownMock.mockClear();
    const { container } = renderRole('system', 'Error: network exploded');

    expect(screen.queryByText('Assistant')).toBeNull();
    expect(renderMarkdownMock).not.toHaveBeenCalled();
    expect(screen.getByText('Error: network exploded')).not.toBeNull();
    expect(container.querySelector('[class*="bubbleSystem"]')).not.toBeNull();
    expect(container.querySelector('[class*="bubbleCommand"]')).toBeNull();
  });
});

describe('MessageBlock code-block copy button', () => {
  beforeEach(() => {
    renderMarkdownMock.mockReset();
    renderMarkdownMock.mockImplementation(
      () =>
        '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> x = 1;</code></pre>',
    );
  });

  function renderAssistant() {
    return render(
      <MessageBlock
        message={makeMessage([], { role: 'assistant', content: 'code' })}
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
  }

  it('injects a copy button into each rendered code block', () => {
    const { container } = renderAssistant();
    expect(container.querySelector('pre button[data-copy-btn]')).not.toBeNull();
  });

  it('re-injects the copy button after React re-commits the markdown subtree', async () => {
    // Regression: the markdown is set via dangerouslySetInnerHTML, so React
    // owns the subtree and re-applies it on later commits, silently wiping any
    // button we appended. A MutationObserver must re-decorate. Simulate that
    // re-commit by replacing the container's innerHTML and assert the button
    // comes back. (A render-effect keyed on the HTML string would NOT recover
    // here, which is the bug this guards against.)
    const { container } = renderAssistant();
    const block = container.querySelector('pre');
    const mdRoot = block?.parentElement;
    expect(mdRoot).not.toBeNull();
    expect(mdRoot?.querySelector('button[data-copy-btn]')).not.toBeNull();

    await act(async () => {
      // React replacing the subtree — pre is recreated without our button.
      (mdRoot as HTMLElement).innerHTML =
        '<pre><code class="hljs language-ts">const y = 2;</code></pre>';
    });

    await waitFor(() =>
      expect(mdRoot?.querySelector('button[data-copy-btn]')).not.toBeNull(),
    );
  });

  it('copies the code text and shows the copied state only on success', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    try {
      const { container } = renderAssistant();
      const button = container.querySelector(
        'pre button[data-copy-btn]',
      ) as HTMLButtonElement;
      expect(button.getAttribute('aria-label')).toBe('Copy code');

      await act(async () => {
        button.click();
      });

      expect(writeText).toHaveBeenCalledWith('const x = 1;');
      await waitFor(() =>
        expect(button.getAttribute('aria-label')).toBe('Copied'),
      );
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator as unknown as object, 'clipboard');
    }
  });

  it('does not show the copied state when the copy fails', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('blocked'));
    const originalClip = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const originalExec = document.execCommand;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    // Force the execCommand fallback to fail too, so the copy resolves false.
    document.execCommand = vi.fn(() => false) as typeof document.execCommand;
    try {
      const { container } = renderAssistant();
      const button = container.querySelector(
        'pre button[data-copy-btn]',
      ) as HTMLButtonElement;

      await act(async () => {
        button.click();
        // Flush the copyToClipboard chain: writeText reject → catch →
        // execCommand → resolve(false) → .then.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalled();
      expect(button.getAttribute('aria-label')).toBe('Copy code');
    } finally {
      document.execCommand = originalExec;
      if (originalClip)
        Object.defineProperty(navigator, 'clipboard', originalClip);
      else Reflect.deleteProperty(navigator as unknown as object, 'clipboard');
    }
  });
});
