/**
 * Admin statistics classify destinations on the gateway before crossing the API.
 * Unlike gateway-service, this reader only aggregates persisted activity;
 * it neither starts channels nor changes sessions or delivery state.
 */
import { resolveChannelTargetKind } from '../channels/channel-descriptors.js';
import {
  getStatisticsTotals,
  listMessageTrendByDay,
  listSessionTrendByDay,
  listStatsByChannel,
  listUsageDailyBreakdown,
} from '../memory/db.js';
import type {
  GatewayAdminStatisticsChannelRow,
  GatewayAdminStatisticsResponse,
  GatewayAdminStatisticsTrendDay,
} from './gateway-types.js';

const STATISTICS_MIN_DAYS = 1;
const STATISTICS_MAX_DAYS = 90;
const STATISTICS_DEFAULT_DAYS = 30;

function normalizeStatisticsDays(raw: number | string | undefined): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number.parseInt(raw, 10)
        : STATISTICS_DEFAULT_DAYS;
  if (!Number.isFinite(parsed)) {
    return STATISTICS_DEFAULT_DAYS;
  }
  return Math.max(
    STATISTICS_MIN_DAYS,
    Math.min(STATISTICS_MAX_DAYS, Math.floor(parsed)),
  );
}

function toIsoDate(daysOffsetFromToday: number): string {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() + daysOffsetFromToday);
  return now.toISOString().slice(0, 10);
}

export function getGatewayAdminStatistics(params?: {
  days?: number | string;
}): GatewayAdminStatisticsResponse {
  const days = normalizeStatisticsDays(params?.days);
  const startDate = toIsoDate(-(days - 1));
  const endDate = toIsoDate(0);

  const messageTrend = listMessageTrendByDay({ days });
  const sessionTrend = listSessionTrendByDay({ days });
  const usageTrend = listUsageDailyBreakdown({ days });
  const channelRows = listStatsByChannel({ days });
  const totals = getStatisticsTotals({ days });

  const trendByDay = new Map<string, GatewayAdminStatisticsTrendDay>();
  // Seed every UTC calendar day in [startDate, endDate] with zeros so the
  // response always covers `rangeDays` contiguous days, even when no
  // activity was recorded.
  for (let offset = 0; offset < days; offset += 1) {
    const date = toIsoDate(-(days - 1 - offset));
    trendByDay.set(date, {
      date,
      newSessions: 0,
      activeSessions: 0,
      userMessages: 0,
      assistantMessages: 0,
      totalMessages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      callCount: 0,
      toolCalls: 0,
      costUsd: 0,
    });
  }

  // SQLite may emit timestamps from the rolling-window helpers that fall
  // just before startDate (when a query window is wider than the response
  // window). Drop those; they're outside the documented range.
  const upsertDay = (
    day: string,
    apply: (target: GatewayAdminStatisticsTrendDay) => void,
  ): void => {
    if (!day || day < startDate || day > endDate) return;
    const target = trendByDay.get(day);
    if (target) apply(target);
  };

  for (const row of messageTrend) {
    upsertDay(row.day, (day) => {
      day.userMessages = row.user_messages;
      day.assistantMessages = row.assistant_messages;
      day.totalMessages = row.total_messages;
    });
  }
  for (const row of sessionTrend) {
    upsertDay(row.day, (day) => {
      day.newSessions = row.new_sessions;
      day.activeSessions = row.active_sessions;
    });
  }
  for (const row of usageTrend) {
    upsertDay(row.day, (day) => {
      day.inputTokens = row.total_input_tokens;
      day.outputTokens = row.total_output_tokens;
      day.cacheReadTokens = row.total_cache_read_tokens;
      day.cacheWriteTokens = row.total_cache_write_tokens;
      day.totalTokens = row.total_tokens;
      day.callCount = row.call_count;
      day.toolCalls = row.total_tool_calls;
      day.costUsd = row.total_cost_usd;
    });
  }

  const trend = Array.from(trendByDay.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  const usageTotals = trend.reduce(
    (acc, day) => {
      acc.totalInputTokens += day.inputTokens;
      acc.totalOutputTokens += day.outputTokens;
      acc.totalCacheReadTokens += day.cacheReadTokens;
      acc.totalCacheWriteTokens += day.cacheWriteTokens;
      acc.totalTokens += day.totalTokens;
      acc.totalCostUsd += day.costUsd;
      acc.callCount += day.callCount;
      acc.totalToolCalls += day.toolCalls;
      return acc;
    },
    {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      callCount: 0,
      totalToolCalls: 0,
    },
  );

  const channels: GatewayAdminStatisticsChannelRow[] = channelRows.map(
    (row) => ({
      channelId: row.channel_id || '(unknown)',
      channelKind: resolveChannelTargetKind(row.channel_id) ?? null,
      sessionCount: row.session_count,
      userMessages: row.user_messages,
      assistantMessages: row.assistant_messages,
      totalMessages: row.total_messages,
    }),
  );

  return {
    rangeDays: days,
    startDate,
    endDate,
    totals: {
      newSessions: totals.new_sessions,
      activeSessions: totals.active_sessions,
      totalMessages: totals.total_messages,
      userMessages: totals.user_messages,
      assistantMessages: totals.assistant_messages,
      ...usageTotals,
    },
    trend,
    channels,
  };
}
