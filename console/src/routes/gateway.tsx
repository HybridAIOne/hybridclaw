import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { reloadGateway } from '../api/client';
import { useAuth } from '../auth';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { ProviderHealthPanel } from '../components/provider-health';
import { useToast } from '../components/toast';
import { BooleanPill, MetricCard, PageHeader, Panel } from '../components/ui';
import { useLiveEvents } from '../hooks/use-live-events';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatUptime } from '../lib/format';

export function GatewayPage() {
  const auth = useAuth();
  const toast = useToast();
  const live = useLiveEvents(auth.token);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const status = live.status || auth.gatewayStatus;
  const providerEntries = Object.entries(
    status?.providerHealth || status?.localBackends || {},
  );
  const schedulerJobs = status?.scheduler?.jobs || [];
  const reloadMutation = useMutation({
    mutationFn: () => reloadGateway(auth.token),
    onSuccess: () => {
      toast.success('Gateway reloaded.');
    },
    onError: (error) => {
      toast.error('Gateway reload failed', getErrorMessage(error));
    },
  });

  const navigate = useNavigate();

  if (!status) {
    return <div className="empty-state">Gateway status is unavailable.</div>;
  }

  const reloadBusy = reloadMutation.isPending;
  const sandboxWarning =
    status.sandbox?.mode === 'host' ? null : status.sandbox?.warning || null;
  return (
    <div className="page-stack">
      <PageHeader
        title="Gateway"
        actions={
          <div className="button-row">
            <div className="status-pill">
              <span
                className={
                  live.connection === 'open' ? 'status-dot live' : 'status-dot'
                }
              />
              {live.connection === 'open' ? 'connected' : 'status snapshot'}
            </div>
            <button
              type="button"
              className="primary-button"
              disabled={reloadBusy}
              onClick={() => setReloadConfirmOpen(true)}
              aria-busy={reloadBusy}
            >
              {reloadBusy ? (
                <span className="button-with-spinner">
                  <span aria-hidden="true" className="button-spinner" />
                  Reloading Gateway
                </span>
              ) : (
                'Reload Gateway'
              )}
            </button>
          </div>
        }
      />
      <div className="metric-grid">
        <MetricCard label="Uptime" value={formatUptime(status.uptime)} />
        <MetricCard label="Sessions" value={String(status.sessions)} />
        <MetricCard label="Providers" value={String(providerEntries.length)} />
        <MetricCard
          label="Scheduler jobs"
          value={String(schedulerJobs.length)}
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
          {sandboxWarning ? (
            <p className="error-banner">{sandboxWarning}</p>
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
        <ProviderHealthPanel
          title="Provider health"
          entries={providerEntries}
          onLogin={() => void navigate({ to: '/config' })}
        />

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
      <Dialog open={reloadConfirmOpen} onOpenChange={setReloadConfirmOpen}>
        <DialogContent size="sm" role="alertdialog">
          <DialogHeader>
            <DialogTitle>Reload Gateway?</DialogTitle>
            <DialogDescription>
              This reloads runtime config and refreshes secrets without
              restarting the workspace container.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="ghost-button">Cancel</DialogClose>
            <DialogClose
              className="primary-button"
              onClick={() => reloadMutation.mutate()}
            >
              Reload
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
