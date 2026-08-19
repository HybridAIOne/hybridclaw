import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamApproval } from '../../api/chat-types';
import { ApprovalCard } from './approval-card';

function makeApproval(
  overrides: Partial<ChatStreamApproval> = {},
): ChatStreamApproval {
  return {
    type: 'approval',
    approvalId: 'approve123',
    approvalTier: 'yellow',
    prompt: [
      'Ich muss den Thumbnail-Snapshot fuer Backyard ausloesen.',
      'Kamera: Backyard (id: 258420, xt2)',
      'Netzwerk: Outdoor (id: 170873)',
      'Aktion: Thumbnail-Snapshot triggern (POST)',
      'Status: Kamera ist online, Batterie OK, aber Wi-Fi schwach (1/5)',
      'Approval ID: approve123',
      'Reply `yes` to approve once.',
    ].join('\n'),
    intent: 'trigger a thumbnail snapshot',
    reason: 'this contacts the Blink camera API',
    commandPreview: 'POST /network/170873/camera/258420/thumbnail',
    toolName: 'blink',
    allowSession: true,
    allowAgent: false,
    allowAll: false,
    expiresAt: null,
    ...overrides,
  };
}

describe('ApprovalCard', () => {
  it('renders amber approvals as a structured confirmation card', () => {
    const onAction = vi.fn();

    render(
      <ApprovalCard
        approval={makeApproval()}
        busy={false}
        onAction={onAction}
      />,
    );

    expect(screen.getByText('Amber')).not.toBeNull();
    expect(screen.getByText('Confirmation required')).not.toBeNull();
    expect(screen.getByText('Kamera')).not.toBeNull();
    expect(screen.getByText('Backyard (id: 258420, xt2)')).not.toBeNull();
    expect(screen.getByText('Request')).not.toBeNull();
    expect(
      screen.getByText('POST /network/170873/camera/258420/thumbnail'),
    ).not.toBeNull();
    expect(screen.queryByText('Reply `yes` to approve once.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onAction).toHaveBeenCalledWith('once', 'approve123');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAction).toHaveBeenCalledWith('deny', 'approve123');

    fireEvent.click(screen.getByRole('button', { name: 'Trust session' }));
    expect(onAction).toHaveBeenCalledWith('session', 'approve123');
    expect(screen.queryByRole('button', { name: 'Trust agent' })).toBeNull();
  });

  it('hides the action buttons and explains why for a responded card', () => {
    const onAction = vi.fn();

    render(
      <ApprovalCard
        approval={makeApproval()}
        busy={false}
        onAction={onAction}
        status="responded"
        respondedAction="session"
      />,
    );

    expect(screen.getByText('Approved for this session.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trust session' })).toBeNull();
  });

  it.each([
    ['once', 'Approved — the agent will continue.'],
    ['agent', 'Approved for this agent.'],
    ['all', 'Always allowed.'],
    ['deny', 'Cancelled.'],
  ] as const)('captions a responded %s action correctly', (action, caption) => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        busy={false}
        onAction={vi.fn()}
        status="responded"
        respondedAction={action}
      />,
    );
    expect(screen.getByText(caption)).not.toBeNull();
  });

  it('hides the action buttons and explains a superseded card', () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        busy={false}
        onAction={vi.fn()}
        status="superseded"
      />,
    );

    expect(
      screen.getByText(
        'No longer pending — superseded by a newer approval request.',
      ),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });

  it('hides the action buttons and explains an expired card', () => {
    render(
      <ApprovalCard
        approval={makeApproval()}
        busy={false}
        onAction={vi.fn()}
        status="expired"
      />,
    );

    expect(
      screen.getByText(
        'Expired — ask the agent to retry if you still want this.',
      ),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });
});
