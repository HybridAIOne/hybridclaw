import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatContextSnapshot } from '../../api/chat-types';
import { renderWithProviders } from '../../test-utils';
import { ContextRing } from './context-ring';

const fetchChatContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../api/chat', () => ({
  fetchChatContext: fetchChatContextMock,
}));

function makeSnapshot(
  overrides: Partial<ChatContextSnapshot> = {},
): ChatContextSnapshot {
  return {
    sessionId: 'session-a',
    model: 'test-model',
    contextUsedTokens: 124_000,
    contextBudgetTokens: 200_000,
    contextUsagePercent: 62,
    contextRemainingTokens: 76_000,
    compactionCount: 3,
    compactionTokenBudget: 2_000_000,
    compactionMessageThreshold: 120,
    compactionKeepRecent: 10,
    messageCount: 40,
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: 1_500_000,
    cacheWriteTokens: 950,
    cacheHitPercent: 81.6,
    ...overrides,
  };
}

function renderRing(snapshot: ChatContextSnapshot | null) {
  fetchChatContextMock.mockResolvedValue({
    sessionId: 'session-a',
    snapshot,
  });
  return renderWithProviders(
    <ContextRing sessionId="session-a" token="test-token" enabled />,
  );
}

function tooltipRow(name: string): string {
  const row = Array.from(
    screen.getByRole('tooltip').querySelectorAll('div'),
  ).find((element) => element.firstElementChild?.textContent === name);
  return row?.lastElementChild?.textContent ?? '';
}

describe('ContextRing', () => {
  afterEach(() => {
    fetchChatContextMock.mockReset();
  });

  it('summarises usage, headroom, cache and compaction in compact units', async () => {
    renderRing(makeSnapshot());

    expect(
      await screen.findByRole('button', {
        name: 'Context usage 62 percent (124K of 200K tokens)',
      }),
    ).toBeTruthy();
    expect(tooltipRow('Used')).toBe('124K / 200K tokens');
    expect(tooltipRow('Headroom')).toBe('76K tokens');
    expect(tooltipRow('Cache')).toBe('82% hit · 1.5M read / 950 written');
    expect(tooltipRow('Compactions')).toBe('3 · 120 msgs / 2M tokens');
  });

  it('falls back when the session has no budget or no snapshot yet', async () => {
    renderRing(
      makeSnapshot({
        contextUsedTokens: null,
        contextBudgetTokens: null,
        contextUsagePercent: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Context usage unavailable' }),
    ).toBeTruthy();
    expect(tooltipRow('Used')).toBe('no usage recorded yet');
  });

  it('shows n/a compaction details before the first snapshot', async () => {
    renderRing(null);
    await vi.waitFor(() => expect(fetchChatContextMock).toHaveBeenCalled());
    expect(tooltipRow('Compactions')).toBe('n/a');
  });
});
