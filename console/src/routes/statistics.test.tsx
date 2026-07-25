import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminStatisticsResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { StatisticsPage } from './statistics';

const teamsThreadId =
  '19:2aYaLicf8I08ay4ANzoMK6JFd3LBw5AT3JeKZCLOQTk1@thread.tacv2;messageid=1784888241570';
const teamsChatId = 'a:1uoW2tioFMsv_ZBPO8jcd9Gv91vgn0M';

vi.mock('../api/client', () => ({
  fetchStatistics: (): Promise<AdminStatisticsResponse> =>
    Promise.resolve({
      rangeDays: 30,
      startDate: '2026-06-26',
      endDate: '2026-07-25',
      totals: {
        newSessions: 3,
        activeSessions: 3,
        totalMessages: 8,
        userMessages: 4,
        assistantMessages: 4,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
        totalToolCalls: 0,
      },
      trend: [],
      channels: [
        {
          channelId: teamsThreadId,
          sessionCount: 2,
          userMessages: 3,
          assistantMessages: 3,
          totalMessages: 6,
        },
        {
          channelId: teamsChatId,
          sessionCount: 1,
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2,
        },
        {
          channelId: 'web',
          sessionCount: 1,
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2,
        },
      ],
    }),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

describe('StatisticsPage', () => {
  it('groups raw Teams conversation ids under the Teams channel type', async () => {
    renderWithProviders(<StatisticsPage />);

    expect(await screen.findByText('Microsoft Teams')).toBeTruthy();
    expect(screen.getByText('2 destinations')).toBeTruthy();
    expect(screen.getByText('Web')).toBeTruthy();
    expect(screen.queryByText(teamsThreadId)).toBeNull();
    expect(screen.queryByText(teamsChatId)).toBeNull();
  });
});
