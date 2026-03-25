import { useAuth } from '../auth';
import {
  Banner,
  BooleanPill,
  EmptyState,
  KeyValueGrid,
  KeyValueItem,
  ListRow,
  MetricCard,
  PageHeader,
  Panel,
} from '../components/ui';
import { useLiveEvents } from '../hooks/use-live-events';
import {
  formatDateTime,
  formatRelativeTime,
  formatUptime,
} from '../lib/format';

export function GatewayPage() {
  const auth = useAuth();
  const live = useLiveEvents(auth.token);
  const status = live.status || auth.gatewayStatus;
  const providerEntries = Object.entries(
    status?.providerHealth || status?.localBackends || {},
  );
  const schedulerJobs = status?.scheduler?.jobs || [];

  if (!status) {
    return <EmptyState>Gateway status is unavailable.</EmptyState>;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Gateway"
        actions={
          <div className="status-pill">
            <span
              className={
                live.connection === 'open' ? 'status-dot live' : 'status-dot'
              }
            />
            {live.connection === 'open'
              ? `live updates ${live.lastEventAt ? formatRelativeTime(new Date(live.lastEventAt).toISOString()) : ''}`.trim()
              : 'status snapshot'}
          </div>
        }
      />

      <div className="metric-grid">
        <MetricCard
          label="Uptime"
          value={formatUptime(status.uptime)}
          detail={`version ${status.version}`}
        />
        <MetricCard
          label="Sessions"
          value={String(status.sessions)}
          detail={`${status.activeContainers} active sandbox${status.activeContainers === 1 ? '' : 'es'}`}
        />
        <MetricCard
          label="Providers"
          value={String(providerEntries.length)}
          detail="health entries surfaced"
        />
        <MetricCard
          label="Scheduler jobs"
          value={String(schedulerJobs.length)}
          detail="current runtime registry"
        />
      </div>

      <div className="two-column-grid">
        <Panel title="Runtime">
          <KeyValueGrid>
            <KeyValueItem label="Version" value={status.version} />
            <KeyValueItem label="PID" value={status.pid ?? 'n/a'} />
            <KeyValueItem
              label="Timestamp"
              value={formatDateTime(status.timestamp)}
            />
            <KeyValueItem
              label="Default model"
              value={status.defaultModel}
            />
            <KeyValueItem
              label="Web API auth"
              value={
                <BooleanPill
                  value={status.webAuthConfigured}
                  trueLabel="on"
                  falseLabel="off"
                />
              }
            />
            <KeyValueItem
              label="RAG default"
              value={
                <BooleanPill
                  value={status.ragDefault}
                  trueLabel="on"
                  falseLabel="off"
                />
              }
            />
          </KeyValueGrid>
        </Panel>

        <Panel title="Services" accent="warm">
          <KeyValueGrid>
            <KeyValueItem
              label="Sandbox mode"
              value={status.sandbox?.mode || 'unknown'}
            />
            <KeyValueItem
              label="Sandbox sessions"
              value={
                status.sandbox?.activeSessions ?? status.activeContainers
              }
            />
            <KeyValueItem
              label="Codex auth"
              value={
                <BooleanPill
                  value={Boolean(
                    status.codex?.authenticated &&
                      !status.codex?.reloginRequired,
                  )}
                  trueLabel="active"
                  falseLabel="inactive"
                />
              }
            />
            <KeyValueItem
              label="Codex source"
              value={status.codex?.source || 'none'}
            />
            <KeyValueItem
              label="Observability"
              value={
                <BooleanPill
                  value={Boolean(
                    status.observability?.enabled &&
                      status.observability?.running,
                  )}
                  trueLabel="active"
                  falseLabel="inactive"
                />
              }
            />
            <KeyValueItem
              label="Last observability success"
              value={formatDateTime(
                status.observability?.lastSuccessAt || null,
              )}
            />
          </KeyValueGrid>
          {status.sandbox?.warning ? (
            <Banner variant="error">{status.sandbox.warning}</Banner>
          ) : null}
          {status.codex?.reloginRequired ? (
            <Banner variant="error">Codex login is required again.</Banner>
          ) : null}
          {status.observability?.lastError ? (
            <Banner variant="error">
              {status.observability.lastError}
            </Banner>
          ) : null}
        </Panel>
      </div>

      <div className="two-column-grid">
        <Panel title="Provider health">
          {providerEntries.length === 0 ? (
            <EmptyState>No provider health data is available.</EmptyState>
          ) : (
            <div className="list-stack">
              {providerEntries.map(([name, provider]) => (
                <ListRow
                  key={name}
                  title={name}
                  meta={
                    provider.detail ||
                    (provider.reachable
                      ? `${provider.latencyMs ?? 0}ms`
                      : provider.error || 'unreachable')
                  }
                  status={
                    <div className="row-status-stack">
                      <BooleanPill
                        value={provider.reachable}
                        trueLabel="healthy"
                        falseLabel="down"
                      />
                      <small>{provider.modelCount ?? 0} models</small>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Scheduler snapshot" accent="warm">
          {schedulerJobs.length === 0 ? (
            <EmptyState>No scheduler jobs are registered.</EmptyState>
          ) : (
            <div className="list-stack">
              {schedulerJobs.slice(0, 8).map((job) => (
                <ListRow
                  key={job.id}
                  title={job.name}
                  meta={
                    job.nextRunAt
                      ? `next ${formatDateTime(job.nextRunAt)}`
                      : 'no next run scheduled'
                  }
                  status={
                    <div className="row-status-stack">
                      <BooleanPill
                        value={job.enabled && !job.disabled}
                        trueLabel="active"
                        falseLabel="inactive"
                      />
                      <small>{job.lastStatus || 'ready'}</small>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
