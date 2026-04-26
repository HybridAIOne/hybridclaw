import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { fetchStatistics } from '../api/client';
import type {
  AdminStatisticsChannelRow,
  AdminStatisticsTrendDay,
} from '../api/types';
import { useAuth } from '../auth';
import { MetricCard, PageHeader, Panel } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import {
  formatCompactNumber,
  formatTokenBreakdown,
  formatUsd,
  pluralize,
} from '../lib/format';

const RANGE_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 60, label: 'Last 60 days' },
  { value: 90, label: 'Last 90 days' },
];

export function StatisticsPage() {
  const auth = useAuth();
  const [days, setDays] = useState<number>(30);

  const statisticsQuery = useQuery({
    queryKey: ['statistics', auth.token, days],
    queryFn: () => fetchStatistics(auth.token, days),
    refetchInterval: 60_000,
  });

  const statistics = statisticsQuery.data;

  const trend = statistics?.trend ?? [];
  const channels = statistics?.channels ?? [];
  const totals = statistics?.totals;

  const rangeSelect = (
    <label className="header-actions">
      <span className="supporting-text" style={{ marginRight: 8 }}>
        Range
      </span>
      <select
        value={days}
        onChange={(event) => setDays(Number.parseInt(event.target.value, 10))}
      >
        {RANGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  if (statisticsQuery.isLoading && !statistics) {
    return (
      <div className="page-stack">
        <PageHeader title="Statistics" actions={rangeSelect} />
        <div className="empty-state">Loading statistics…</div>
      </div>
    );
  }

  if (statisticsQuery.isError && !statistics) {
    return (
      <div className="page-stack">
        <PageHeader title="Statistics" actions={rangeSelect} />
        <div className="empty-state error">
          {getErrorMessage(statisticsQuery.error)}
        </div>
      </div>
    );
  }

  if (!statistics || !totals) {
    return (
      <div className="page-stack">
        <PageHeader title="Statistics" actions={rangeSelect} />
        <div className="empty-state">No statistics available.</div>
      </div>
    );
  }

  const rangeDescription = `${statistics.startDate} → ${statistics.endDate}`;

  return (
    <div className="page-stack">
      <PageHeader
        title="Statistics"
        description={`Activity across the last ${pluralize(statistics.rangeDays, 'day')} (${rangeDescription}).`}
        actions={rangeSelect}
      />

      <div className="metric-grid">
        <MetricCard
          label="Active sessions"
          value={formatCompactNumber(totals.activeSessions)}
          detail={`${totals.newSessions} new in range`}
        />
        <MetricCard
          label="Messages"
          value={formatCompactNumber(totals.totalMessages)}
          detail={`${formatCompactNumber(totals.userMessages)} user / ${formatCompactNumber(totals.assistantMessages)} assistant`}
        />
        <MetricCard
          label="Tokens"
          value={formatCompactNumber(totals.totalTokens)}
          detail={formatTokenBreakdown({
            inputTokens: totals.totalInputTokens,
            outputTokens: totals.totalOutputTokens,
          })}
        />
        <MetricCard
          label="Cost"
          value={formatUsd(totals.totalCostUsd)}
          detail={`${pluralize(totals.callCount, 'call')} · ${pluralize(totals.totalToolCalls, 'tool call')}`}
        />
      </div>

      <div className="two-column-grid">
        <Panel
          title="Message trend"
          subtitle="User vs assistant messages per day"
        >
          <TrendChart
            trend={trend}
            series={[
              {
                key: 'userMessages',
                label: 'User',
                color: 'var(--primary)',
              },
              {
                key: 'assistantMessages',
                label: 'Assistant',
                color: 'var(--success)',
              },
            ]}
          />
        </Panel>
        <Panel title="Session trend" subtitle="New vs active sessions per day">
          <TrendChart
            trend={trend}
            series={[
              {
                key: 'newSessions',
                label: 'New',
                color: 'var(--primary)',
              },
              {
                key: 'activeSessions',
                label: 'Active',
                color: 'var(--accent-foreground)',
              },
            ]}
            stacked={false}
          />
        </Panel>
      </div>

      <Panel
        title="Channel breakdown"
        subtitle="Distribution of sessions and messages by channel"
      >
        <ChannelBreakdown channels={channels} />
      </Panel>
    </div>
  );
}

type TrendSeriesKey =
  | 'userMessages'
  | 'assistantMessages'
  | 'newSessions'
  | 'activeSessions';

type TrendSeries = {
  key: TrendSeriesKey;
  label: string;
  color: string;
};

function TrendChart(props: {
  trend: AdminStatisticsTrendDay[];
  series: TrendSeries[];
  stacked?: boolean;
}) {
  const stacked = props.stacked !== false;

  const { maxValue, hasData } = useMemo(() => {
    let max = 0;
    let any = false;
    for (const day of props.trend) {
      if (stacked) {
        const total = props.series.reduce(
          (sum, series) => sum + (day[series.key] || 0),
          0,
        );
        if (total > 0) any = true;
        if (total > max) max = total;
      } else {
        for (const series of props.series) {
          const value = day[series.key] || 0;
          if (value > 0) any = true;
          if (value > max) max = value;
        }
      }
    }
    return { maxValue: max, hasData: any };
  }, [props.trend, props.series, stacked]);

  if (!hasData || props.trend.length === 0) {
    return (
      <p className="supporting-text">No activity in the selected range.</p>
    );
  }

  const chartHeight = 140;
  const barGap = 6;
  const barWidth = Math.max(
    6,
    Math.min(28, Math.floor(480 / Math.max(1, props.trend.length))),
  );
  const chartWidth = props.trend.length * (barWidth + barGap);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        {props.series.map((series) => (
          <span
            key={series.key}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: '0.8rem',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: series.color,
              }}
            />
            {series.label}
          </span>
        ))}
      </div>
      <svg
        role="img"
        aria-label="Daily activity chart"
        viewBox={`0 0 ${chartWidth} ${chartHeight + 24}`}
        width="100%"
        height={chartHeight + 24}
        preserveAspectRatio="none"
      >
        <title>Daily activity chart</title>
        {props.trend.map((day, index) => {
          const x = index * (barWidth + barGap);
          let cumulative = 0;
          return (
            <g key={day.date}>
              {props.series.map((series) => {
                const value = day[series.key] || 0;
                const height =
                  maxValue > 0 ? (value / maxValue) * chartHeight : 0;
                const y = stacked
                  ? chartHeight - cumulative - height
                  : chartHeight - height;
                if (stacked) cumulative += height;
                return (
                  <rect
                    key={series.key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(0, height)}
                    fill={series.color}
                    opacity={stacked ? 1 : 0.85}
                  >
                    <title>{`${day.date} · ${series.label}: ${value}`}</title>
                  </rect>
                );
              })}
              {index === 0 ||
              index === props.trend.length - 1 ||
              index === Math.floor(props.trend.length / 2) ? (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  fontSize="10"
                  fill="currentColor"
                  opacity="0.6"
                >
                  {day.date.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ChannelBreakdown(props: { channels: AdminStatisticsChannelRow[] }) {
  if (props.channels.length === 0) {
    return (
      <p className="supporting-text">
        No channel activity recorded in the selected range.
      </p>
    );
  }

  const totalSessions = props.channels.reduce(
    (sum, row) => sum + row.sessionCount,
    0,
  );
  const totalMessages = props.channels.reduce(
    (sum, row) => sum + row.totalMessages,
    0,
  );

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th style={{ textAlign: 'right' }}>Sessions</th>
            <th style={{ textAlign: 'right' }}>Messages</th>
            <th style={{ textAlign: 'right' }}>User</th>
            <th style={{ textAlign: 'right' }}>Assistant</th>
            <th style={{ minWidth: 140 }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {props.channels.map((channel) => {
            const share =
              totalMessages > 0 ? channel.totalMessages / totalMessages : 0;
            return (
              <tr key={channel.channelId}>
                <td>
                  <strong>{channel.channelId || '(unknown)'}</strong>
                  <small>
                    {totalSessions > 0
                      ? `${Math.round((channel.sessionCount / totalSessions) * 100)}% of sessions`
                      : '—'}
                  </small>
                </td>
                <td style={{ textAlign: 'right' }}>{channel.sessionCount}</td>
                <td style={{ textAlign: 'right' }}>{channel.totalMessages}</td>
                <td style={{ textAlign: 'right' }}>{channel.userMessages}</td>
                <td style={{ textAlign: 'right' }}>
                  {channel.assistantMessages}
                </td>
                <td>
                  <div
                    role="progressbar"
                    aria-label={`${Math.round(share * 100)}% of messages`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(share * 100)}
                    style={{
                      background: 'var(--accent-soft)',
                      borderRadius: 4,
                      height: 8,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.max(2, share * 100)}%`,
                        height: '100%',
                        background: 'var(--primary)',
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
