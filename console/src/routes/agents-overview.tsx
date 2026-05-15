import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { fetchAgentsOverview } from '../api/client';
import type { AgentCard, AgentSessionCard } from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { BooleanPill, PageHeader } from '../components/ui';
import {
  formatCompactNumber,
  formatDateTime,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUptime,
  formatUsd,
} from '../lib/format';

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

function statusLabel(value: AgentCard['status'] | AgentSessionCard['status']) {
  if (value === 'unused') return 'unused';
  return value;
}

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

  const sessionCounts = overview?.totals.sessions || {
    all: overview?.sessions.length || 0,
    active: 0,
    idle: 0,
    stopped: 0,
    running: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };

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

  return (
    <div className="page-stack">
      <PageHeader
        title="Agents"
        description={
          overview
            ? `Last refresh ${formatDateTime(overview.generatedAt)} · uptime ${formatUptime(overview.uptime)}`
            : 'Workspace dashboard'
        }
        actions={
          <div className="button-row">
            <button
              className="ghost-button"
              type="button"
              onClick={() => void agentsQuery.refetch()}
            >
              Refresh
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => void navigate({ to: '/chat' })}
            >
              Open Chat
            </button>
          </div>
        }
      />

      <div className="metric-grid">
        <div className="metric-card">
          <span>Agents</span>
          <strong>{overview?.totals.agents.all ?? 0}</strong>
          <small>{overview?.totals.agents.active ?? 0} active</small>
        </div>
        <div className="metric-card">
          <span>Sessions Live</span>
          <strong>{sessionCounts.running}</strong>
          <small>{sessionCounts.all} total</small>
        </div>
        <div className="metric-card">
          <span>Tokens Used</span>
          <strong>{formatCompactNumber(sessionCounts.totalTokens)}</strong>
          <small>
            {formatTokenBreakdown({
              inputTokens: sessionCounts.totalInputTokens,
              outputTokens: sessionCounts.totalOutputTokens,
            })}
          </small>
        </div>
        <div className="metric-card">
          <span>Total Cost</span>
          <strong>{formatUsd(sessionCounts.totalCostUsd)}</strong>
          <small>
            Ralph {overview?.ralph.enabled ? 'enabled' : 'disabled'}
          </small>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Registered Agents</CardTitle>
          <CardDescription>
            {(overview?.agents.length || 0).toString()} workspace
            {(overview?.agents.length || 0) === 1 ? '' : 's'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!overview?.agents.length ? (
            <div className="empty-state">No agents found.</div>
          ) : (
            <div className="agents-overview-grid">
              {overview.agents.map((agent) => (
                <article className="agents-overview-card" key={agent.id}>
                  <div className="agents-overview-card-header">
                    <div>
                      <h3>{agent.name || agent.id}</h3>
                      <p>{formatSessionSummary(agent)}</p>
                    </div>
                    <BooleanPill
                      value={agent.status === 'active'}
                      trueLabel="active"
                      falseLabel={statusLabel(agent.status)}
                    />
                  </div>
                  <div className="key-value-grid">
                    <div>
                      <span>Default Model</span>
                      <strong>{formatAgentModel(agent)}</strong>
                    </div>
                    <div>
                      <span>Session Models</span>
                      <strong>
                        {agent.effectiveModels.length
                          ? agent.effectiveModels.join(', ')
                          : 'none'}
                      </strong>
                    </div>
                    <div>
                      <span>Workspace</span>
                      <strong>{agent.workspacePath}</strong>
                    </div>
                    <div>
                      <span>Token I/O</span>
                      <strong>
                        {formatTokenBreakdown({
                          inputTokens: agent.inputTokens,
                          outputTokens: agent.outputTokens,
                        })}
                      </strong>
                    </div>
                    <div>
                      <span>Cost</span>
                      <strong>{formatUsd(agent.costUsd)}</strong>
                    </div>
                    <div>
                      <span>Chatbot / RAG</span>
                      <strong>{formatChatbot(agent)}</strong>
                    </div>
                    <div>
                      <span>Last Active</span>
                      <strong>{formatDateTime(agent.lastActive)}</strong>
                    </div>
                    <div>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            {visibleSessions.length} visible of {sessionCounts.all}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="button-row agents-filter-row">
            {SESSION_FILTERS.map((item) => (
              <button
                className={
                  filter === item.key ? 'primary-button' : 'ghost-button'
                }
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
              >
                {item.label}
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
                  <article className="agents-session-card" key={session.id}>
                    <div className="agents-overview-card-header">
                      <div>
                        <h3>{session.name}</h3>
                        <p>{session.task}</p>
                      </div>
                      <BooleanPill
                        value={session.status === 'active'}
                        trueLabel="active"
                        falseLabel={session.status}
                      />
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

                    <div className="key-value-grid">
                      <div>
                        <span>Model</span>
                        <strong>{session.model}</strong>
                      </div>
                      <div>
                        <span>Agent</span>
                        <strong>{session.agentId}</strong>
                      </div>
                      <div>
                        <span>Session ID</span>
                        <strong>{session.sessionId}</strong>
                      </div>
                      <div>
                        <span>Channel</span>
                        <strong>{channelLabel(session)}</strong>
                      </div>
                      <div>
                        <span>Runtime</span>
                        <strong>{session.runtimeMinutes}m</strong>
                      </div>
                      <div>
                        <span>Token I/O</span>
                        <strong>
                          {formatTokenBreakdown({
                            inputTokens: session.inputTokens,
                            outputTokens: session.outputTokens,
                          })}
                        </strong>
                      </div>
                      <div>
                        <span>Cost</span>
                        <strong>{formatUsd(session.costUsd)}</strong>
                      </div>
                      <div>
                        <span>Last Active</span>
                        <strong>
                          {formatRelativeTime(session.lastActive)}
                        </strong>
                      </div>
                    </div>

                    {isOpen ? (
                      <pre className="agents-session-output">
                        {output.join('\n')}
                      </pre>
                    ) : null}

                    <div className="button-row">
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => {
                          localStorage.setItem(
                            'hybridclaw_session',
                            session.sessionId,
                          );
                          void navigate({ to: '/chat' });
                        }}
                      >
                        Open Chat
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => void navigate({ to: '/admin/sessions' })}
                      >
                        Open Sessions
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
        </CardContent>
      </Card>
    </div>
  );
}
