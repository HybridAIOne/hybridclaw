import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { restartGateway, validateToken } from '../api/client';
import { useAuth } from '../auth';
import { useToast } from '../components/toast';
import { BooleanPill, MetricCard, PageHeader, Panel } from '../components/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { useLiveEvents } from '../hooks/use-live-events';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatUptime } from '../lib/format';

const GATEWAY_RESTART_POLL_MS = 1000;

export function GatewayPage() {
  const auth = useAuth();
  const toast = useToast();
  const live = useLiveEvents(auth.token);
  const [polledStatus, setPolledStatus] =
    useState<typeof auth.gatewayStatus>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const status = live.status || polledStatus || auth.gatewayStatus;
  const providerEntries = Object.entries(
    status?.providerHealth || status?.localBackends || {},
  );
  const schedulerJobs = status?.scheduler?.jobs || [];
  const restartMutation = useMutation({
    mutationFn: () => restartGateway(auth.token),
    onMutate: () => {
      setIsRestarting(false);
      setPolledStatus(null);
    },
    onSuccess: () => {
      setIsRestarting(true);
    },
    onError: (error) => {
      toast.error('Gateway restart failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    if (!isRestarting) return;

    let cancelled = false;
    let timeoutId: number | null = null;

    const schedulePoll = () => {
      timeoutId = window.setTimeout(() => {
        void pollStatus();
      }, GATEWAY_RESTART_POLL_MS);
    };

    const pollStatus = async () => {
      try {
        const nextStatus = await validateToken(auth.token);
        if (cancelled) return;
        setPolledStatus(nextStatus);
        setIsRestarting(false);
      } catch {
        if (cancelled) return;
        schedulePoll();
      }
    };

    schedulePoll();
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [auth.token, isRestarting]);

  if (!status) {
    return <div className="empty-state">Gateway status is unavailable.</div>;
  }

  const restartSupported = Boolean(status.lifecycle?.restartSupported);
  const restartBusy = restartMutation.isPending || isRestarting;
  const restartReason =
    status.lifecycle?.restartReason ||
    'Gateway restart is unavailable in the current launch mode.';
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
              className="danger-button"
              disabled={!restartSupported || restartBusy}
              onClick={() => setRestartConfirmOpen(true)}
              title={
                !restartSupported && !restartBusy ? restartReason : undefined
              }
              aria-busy={restartBusy}
            >
              {restartBusy ? (
                <span className="button-with-spinner">
                  <span aria-hidden="true" className="button-spinner" />
                  Restarting Gateway
                </span>
              ) : (
                'Restart Gateway'
              )}
            </button>
          </div>
        }
      />
      {!restartSupported ? (
        <p className="supporting-text">{restartReason}</p>
      ) : null}
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
      <AlertDialog
        open={restartConfirmOpen}
        onOpenChange={setRestartConfirmOpen}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Gateway?</AlertDialogTitle>
            <AlertDialogDescription>
              This will interrupt all active sessions. The gateway will be
              unavailable for a few seconds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => restartMutation.mutate()}>
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
