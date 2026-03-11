import { useAuth } from '../auth';
import { BooleanPill, MetricCard, PageHeader, Panel } from '../components/ui';
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
    return <div className="empty-state">Gateway status is unavailable.</div>;
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
          <div className="key-value-grid">
            <div>
              <span>Version</span>
              <strong>{status.version}</strong>
            </div>
            <div>
              <span>PID</span>
              <strong>{status.pid ?? 'n/a'}</strong>
            </div>
            <div>
              <span>Timestamp</span>
              <strong>{formatDateTime(status.timestamp)}</strong>
            </div>
            <div>
              <span>Default model</span>
              <strong>{status.defaultModel}</strong>
            </div>
            <div>
              <span>Web API auth</span>
              <BooleanPill
                value={status.webAuthConfigured}
                trueLabel="on"
                falseLabel="off"
              />
            </div>
            <div>
              <span>RAG default</span>
              <BooleanPill
                value={status.ragDefault}
                trueLabel="on"
                falseLabel="off"
              />
            </div>
          </div>
        </Panel>

        <Panel title="Services" accent="warm">
          <div className="key-value-grid">
            <div>
              <span>Sandbox mode</span>
              <strong>{status.sandbox?.mode || 'unknown'}</strong>
            </div>
            <div>
              <span>Sandbox sessions</span>
              <strong>
                {status.sandbox?.activeSessions ?? status.activeContainers}
              </strong>
            </div>
            <div>
              <span>Codex auth</span>
              <BooleanPill
                value={Boolean(
                  status.codex?.authenticated && !status.codex?.reloginRequired,
                )}
                trueLabel="active"
                falseLabel="inactive"
              />
            </div>
            <div>
              <span>Codex source</span>
              <strong>{status.codex?.source || 'none'}</strong>
            </div>
            <div>
              <span>Observability</span>
              <BooleanPill
                value={Boolean(
                  status.observability?.enabled &&
                    status.observability?.running,
                )}
                trueLabel="active"
                falseLabel="inactive"
              />
            </div>
            <div>
              <span>Last observability success</span>
              <strong>
                {formatDateTime(status.observability?.lastSuccessAt || null)}
              </strong>
            </div>
          </div>
          {status.sandbox?.warning ? (
            <p className="error-banner">{status.sandbox.warning}</p>
          ) : null}
          {status.codex?.reloginRequired ? (
            <p className="error-banner">Codex login is required again.</p>
          ) : null}
          {status.observability?.lastError ? (
            <p className="error-banner">{status.observability.lastError}</p>
          ) : null}
        </Panel>
      </div>

      <div className="two-column-grid">
        <Panel title="Provider health">
          {providerEntries.length === 0 ? (
            <div className="empty-state">
              No provider health data is available.
            </div>
          ) : (
            <div className="list-stack">
              {providerEntries.map(([name, provider]) => (
                <div className="list-row" key={name}>
                  <div>
                    <strong>{name}</strong>
                    <small>
                      {provider.detail ||
                        (provider.reachable
                          ? `${provider.latencyMs ?? 0}ms`
                          : provider.error || 'unreachable')}
                    </small>
                  </div>
                  <div className="row-status-stack">
                    <BooleanPill
                      value={provider.reachable}
                      trueLabel="healthy"
                      falseLabel="down"
                    />
                    <small>{provider.modelCount ?? 0} models</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Scheduler snapshot" accent="warm">
          {schedulerJobs.length === 0 ? (
            <div className="empty-state">No scheduler jobs are registered.</div>
          ) : (
            <div className="list-stack">
              {schedulerJobs.slice(0, 8).map((job) => (
                <div className="list-row" key={job.id}>
                  <div>
                    <strong>{job.name}</strong>
                    <small>
                      {job.nextRunAt
                        ? `next ${formatDateTime(job.nextRunAt)}`
                        : 'no next run scheduled'}
                    </small>
                  </div>
                  <div className="row-status-stack">
                    <BooleanPill
                      value={job.enabled && !job.disabled}
                      trueLabel="active"
                      falseLabel="inactive"
                    />
                    <small>{job.lastStatus || 'ready'}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
