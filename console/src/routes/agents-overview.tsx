import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { memo, useMemo, useState } from 'react';
import { fetchAgentsOverview } from '../api/client';
import type { AgentCard, AgentSessionCard } from '../api/types';
import { useAuth } from '../auth';
import { ViewSwitchNav } from '../components/view-switch';
import {
  formatCompactNumber,
  formatDateTime,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUptime,
  formatUsd,
} from '../lib/format';
import { logNavigationError } from '../lib/navigation';

type SessionFilter = 'all' | AgentSessionCard['status'];

const SESSION_FILTERS: ReadonlyArray<{
  key: SessionFilter;
  label: string;
}> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'idle', label: 'Idle' },
  { key: 'stopped', label: 'Stopped' },
];

function formatAgentModel(agent: AgentCard): string {
  return agent.model || 'Inherited default';
}

function formatSessionSummary(agent: AgentCard): string {
  if (!agent.sessionCount) return 'No persisted sessions';
  return `${agent.sessionCount} total · ${agent.activeSessions} active · ${agent.idleSessions} idle · ${agent.stoppedSessions} stopped`;
}

function formatChatbot(agent: AgentCard): string {
  const chatbot = agent.chatbotId?.trim() || 'none';
  const rag =
    agent.enableRag == null ? 'inherit' : agent.enableRag ? 'on' : 'off';
  return `Chatbot ${chatbot} · RAG ${rag}`;
}

function channelLabel(session: AgentSessionCard): string {
  if (session.channelName && session.channelName !== session.channelId) {
    return `${session.channelName} · ${session.channelId}`;
  }
  return session.channelId || 'unknown';
}

function statusClassName(
  value: AgentCard['status'] | AgentSessionCard['status'],
): string {
  return `is-${value}`;
}

function StatusBadge(props: {
  status: AgentCard['status'] | AgentSessionCard['status'];
}) {
  return (
    <span className={`agents-status-badge ${statusClassName(props.status)}`}>
      <span className="agents-status-badge-dot" aria-hidden="true" />
      {props.status}
    </span>
  );
}

function terminalLineClassName(value: string): string {
  const lowered = value.toLowerCase();
  if (value.startsWith('$')) return 'is-command';
  if (lowered.includes('error') || lowered.includes('failed'))
    return 'is-error';
  if (lowered.includes('idle') || lowered.includes('waiting'))
    return 'is-warning';
  if (lowered.includes('healthy') || lowered.includes('success'))
    return 'is-success';
  return '';
}

function keyedTerminalLines(sessionId: string, lines: string[]) {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return {
      key: `${sessionId}-${count}-${line}`,
      line,
    };
  });
}

type SessionTerminalProps = {
  sessionId: string;
  title: string;
  output: string[];
};

function SessionTerminalComponent(props: SessionTerminalProps) {
  const outputLines = useMemo(
    () => keyedTerminalLines(props.sessionId, props.output),
    [props.sessionId, props.output],
  );

  return (
    <div className="agents-terminal">
      <div className="agents-terminal-top">
        <span className="agents-terminal-dot is-red" />
        <span className="agents-terminal-dot is-yellow" />
        <span className="agents-terminal-dot is-green" />
        <span className="agents-terminal-label">{props.title}</span>
      </div>
      <div className="agents-session-output">
        {outputLines.map(({ key, line }) => (
          <span
            className={`agents-terminal-line ${terminalLineClassName(line)}`}
            key={key}
          >
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

const SessionTerminal = memo(
  SessionTerminalComponent,
  (previous, next) =>
    previous.sessionId === next.sessionId &&
    previous.title === next.title &&
    previous.output.length === next.output.length &&
    previous.output.every((line, index) => line === next.output[index]),
);

export function AgentsOverviewPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [openOutputIds, setOpenOutputIds] = useState<Set<string>>(new Set());

  const agentsQuery = useQuery({
    queryKey: ['agents-overview', auth.token],
    queryFn: () => fetchAgentsOverview(auth.token),
    refetchInterval: 15_000,
  });

  const overview = agentsQuery.data;
  const visibleSessions = useMemo(() => {
    const sessions = overview?.sessions || [];
    if (filter === 'all') return sessions;
    return sessions.filter((session) => session.status === filter);
  }, [filter, overview?.sessions]);

  function toggleOutput(sessionId: string): void {
    setOpenOutputIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }

  if (agentsQuery.isLoading && !overview) {
    return <div className="empty-state">Loading agents...</div>;
  }

  if (agentsQuery.isError && !overview) {
    return <div className="empty-state error">Agent overview unavailable.</div>;
  }

  if (!overview) {
    return <div className="empty-state">Agent overview unavailable.</div>;
  }

  const sessionCounts = overview.totals.sessions;
  const sessionFilterCounts: Record<SessionFilter, number> = {
    all: sessionCounts.all,
    active: sessionCounts.active,
    idle: sessionCounts.idle,
    stopped: sessionCounts.stopped,
  };

  return (
    <div className="page-stack agents-dashboard">
      <header className="agents-page-header">
        <div className="agents-title-row">
          <h1>Agents</h1>
          <button
            className={
              agentsQuery.isFetching
                ? 'agents-refresh-chip is-spinning'
                : 'agents-refresh-chip'
            }
            type="button"
            onClick={() => void agentsQuery.refetch()}
          >
            <span className="agents-refresh-spinner" aria-hidden="true" />
            <span>
              {overview
                ? `Last refresh ${formatDateTime(overview.generatedAt)}`
                : 'Loading agents'}
            </span>
          </button>
          {overview ? (
            <span className="agents-uptime-chip">
              uptime {formatUptime(overview.uptime)}
            </span>
          ) : null}
        </div>
        <ViewSwitchNav />
      </header>

      <div className="agents-stats-row">
        <div className="agents-stat-card">
          <span className="agents-metric-accent is-green">A</span>
          <span>Agents</span>
          <strong>{overview.totals.agents.all}</strong>
          <small>{overview.totals.agents.active} active</small>
        </div>
        <div className="agents-stat-card">
          <span className="agents-metric-accent is-blue">S</span>
          <span>Sessions Live</span>
          <strong>{sessionCounts.running}</strong>
          <small>{sessionCounts.all} total</small>
        </div>
        <div className="agents-stat-card">
          <span className="agents-metric-accent is-gold">T</span>
          <span>Tokens Used</span>
          <strong>{formatCompactNumber(sessionCounts.totalTokens)}</strong>
          <small>
            {formatTokenBreakdown({
              inputTokens: sessionCounts.totalInputTokens,
              outputTokens: sessionCounts.totalOutputTokens,
            })}
          </small>
        </div>
        <div className="agents-stat-card">
          <span className="agents-metric-accent is-slate">$</span>
          <span>Total Cost</span>
          <strong>{formatUsd(sessionCounts.totalCostUsd)}</strong>
          <small>
            Ralph {overview.ralph?.enabled ? 'enabled' : 'disabled'}
          </small>
        </div>
      </div>

      <section className="agents-dashboard-panel">
        <div className="agents-section-head">
          <div>
            <h2>Registered Agents</h2>
            <p>
              {overview.agents.length.toString()} workspace
              {overview.agents.length === 1 ? '' : 's'} aggregated across every
              bound session.
            </p>
          </div>
        </div>

        <div>
          {!overview.agents.length ? (
            <div className="empty-state">No agents found.</div>
          ) : (
            <div className="agents-overview-grid">
              {overview.agents.map((agent) => (
                <article
                  className={`agents-overview-card ${statusClassName(agent.status)}`}
                  key={agent.id}
                >
                  <div className="agents-overview-card-header">
                    <div>
                      <h3>{agent.name || agent.id}</h3>
                      <p>{formatSessionSummary(agent)}</p>
                      {agent.recentSessionId ? (
                        <div className="agents-tag-row">
                          <span className="agents-tag">
                            Recent {agent.recentSessionId}
                          </span>
                        </div>
                      ) : null}
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                  <div className="agents-meta-grid">
                    <div className="agents-meta-block">
                      <span>Default Model</span>
                      <strong>{formatAgentModel(agent)}</strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Session Models</span>
                      <strong>
                        {agent.effectiveModels.length
                          ? agent.effectiveModels.join(', ')
                          : 'none'}
                      </strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Workspace</span>
                      <strong>{agent.workspacePath}</strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Token I/O</span>
                      <strong>
                        {formatTokenBreakdown({
                          inputTokens: agent.inputTokens,
                          outputTokens: agent.outputTokens,
                        })}
                      </strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Cost</span>
                      <strong>{formatUsd(agent.costUsd)}</strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Chatbot / RAG</span>
                      <strong>{formatChatbot(agent)}</strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Last Active</span>
                      <strong>{formatDateTime(agent.lastActive)}</strong>
                    </div>
                    <div className="agents-meta-block">
                      <span>Messages / Tools</span>
                      <strong>
                        {agent.messageCount} msgs / {agent.toolCalls} calls
                      </strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="agents-dashboard-panel">
        <div className="agents-section-head">
          <div>
            <h2>Sessions</h2>
            <p>
              {visibleSessions.length} visible of {sessionCounts.all} persisted
              per-channel and per-client sessions.
            </p>
          </div>
        </div>

        <div>
          <div
            className="agents-filter-row"
            role="tablist"
            aria-label="Session filters"
          >
            {SESSION_FILTERS.map((item) => (
              <button
                className={
                  filter === item.key
                    ? 'agents-filter-pill is-active'
                    : 'agents-filter-pill'
                }
                key={item.key}
                type="button"
                role="tab"
                aria-selected={filter === item.key}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
                <span className="agents-filter-count">
                  {sessionFilterCounts[item.key]}
                </span>
              </button>
            ))}
          </div>

          {!visibleSessions.length ? (
            <div className="empty-state">No sessions match this filter.</div>
          ) : (
            <div className="agents-session-list">
              {visibleSessions.map((session) => {
                const isOpen = openOutputIds.has(session.id);
                const output = session.output.length
                  ? session.output
                  : ['No recent activity captured for this session yet.'];
                return (
                  <article
                    className={`agents-session-card ${statusClassName(session.status)}`}
                    key={session.id}
                  >
                    <div className="agents-overview-card-header">
                      <div>
                        <h3>{session.name}</h3>
                        <p>{session.task}</p>
                        {session.fullAutoEnabled ? (
                          <span className="agents-fullauto-badge">
                            Full auto
                          </span>
                        ) : null}
                      </div>
                      <StatusBadge status={session.status} />
                    </div>

                    {(session.lastQuestion || session.lastAnswer) && (
                      <div className="agents-preview">
                        {session.lastQuestion ? (
                          <p>
                            <span>Q</span>
                            {session.lastQuestion}
                          </p>
                        ) : null}
                        {session.lastAnswer ? (
                          <p>
                            <span>A</span>
                            {session.lastAnswer}
                          </p>
                        ) : null}
                      </div>
                    )}

                    <div className="agents-meta-grid">
                      <div className="agents-meta-block">
                        <span>Model</span>
                        <strong>{session.model}</strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Agent</span>
                        <strong>{session.agentId}</strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Session ID</span>
                        <strong>{session.sessionId}</strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Channel</span>
                        <strong>{channelLabel(session)}</strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Runtime</span>
                        <strong>{session.runtimeMinutes}m</strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Token I/O</span>
                        <strong>
                          {formatTokenBreakdown({
                            inputTokens: session.inputTokens,
                            outputTokens: session.outputTokens,
                          })}
                        </strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Cost</span>
                        <strong>{formatUsd(session.costUsd)}</strong>
                      </div>
                      <div className="agents-meta-block">
                        <span>Last Active</span>
                        <strong>
                          {formatRelativeTime(session.lastActive)}
                        </strong>
                      </div>
                    </div>

                    {isOpen ? (
                      <SessionTerminal
                        sessionId={session.id}
                        title={session.previewTitle}
                        output={output}
                      />
                    ) : null}

                    <div className="button-row">
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => {
                          void navigate({
                            to: '/admin/sessions',
                            search: { sessionId: session.id },
                          }).catch(logNavigationError);
                        }}
                      >
                        Open Session
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => toggleOutput(session.id)}
                      >
                        {isOpen ? 'Hide Output' : 'Show Output'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
