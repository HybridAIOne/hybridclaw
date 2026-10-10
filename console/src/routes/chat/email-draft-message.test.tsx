/**
 * Structured drafts replace their text fallback only after canonical validation;
 * legacy and malformed replies remain readable through normal markdown.
 */
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../api/chat-types';
import { MessageBlock } from './message-block';

vi.mock('../../api/chat', () => ({
  fetchMediaCapabilities: vi.fn(async () => ({
    dictation: false,
    readAloud: false,
  })),
}));
vi.mock('../../lib/markdown', () => ({
  renderMarkdown: (content: string) => `<p>${content}</p>`,
}));
const draft = {
  from: 'pat@example.com',
  to: ['lee@example.com'],
  subject: 'Friday',
  body: 'See you then.',
  reply: 'Please review.',
};
function show(emailDraft?: ChatMessage['emailDraft']) {
  const message: ChatMessage = {
    id: 'reply-1',
    messageId: 42,
    sessionId: 'mail-session',
    role: 'assistant',
    content: 'Original fallback draft text',
    emailDraft,
  };
  return render(
    <MessageBlock
      message={message}
      token=""
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
it('renders a validated draft once and keeps the separate reply prose', () => {
  show(draft);
  expect(screen.getByRole('region', { name: 'Email draft' })).toBeTruthy();
  expect(screen.getByText('Please review.')).toBeTruthy();
  expect(screen.queryByText('Original fallback draft text')).toBeNull();
  expect(screen.getByText('See you then.')).toBeTruthy();
});
it('retains the text fallback for invalid structured data and legacy replies', () => {
  const view = show({ ...draft, from: 'invalid' });
  expect(screen.queryByRole('region', { name: 'Email draft' })).toBeNull();
  expect(screen.getByText('Original fallback draft text')).toBeTruthy();
  view.unmount();
  show();
  expect(screen.getByText('Original fallback draft text')).toBeTruthy();
});
