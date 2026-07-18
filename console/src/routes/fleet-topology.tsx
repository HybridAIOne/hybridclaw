import { useQuery } from '@tanstack/react-query';
import { fetchFleetTopology } from '../api/client';
import type { AdminFleetTopologyInstanceStatus } from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { BooleanPill, PageHeader } from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function shortFingerprint(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 12)}...${value.slice(-6)}`
    : value;
}

function statusPill(status: AdminFleetTopologyInstanceStatus) {
  if (status === 'online') {
    return <BooleanPill value={true} trueLabel="online" />;
  }
  if (status === 'revoked') {
    return (
      <BooleanPill value={false} falseLabel="revoked" falseTone="danger" />
    );
  }
  return <BooleanPill value={false} falseLabel={status} />;
}

function formatLatency(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value)}ms`
    : 'unknown';
}

export function FleetTopologyPage(props: { embedded?: boolean } = {}) {
  const auth = useAuth();

  const topologyQuery = useQuery({
    queryKey: ['fleet-topology', auth.token],
    queryFn: () => fetchFleetTopology(auth.token),
  });

  const topology = topologyQuery.data;
  const instances = topology?.instances || [];

  return (
    <div className="page-stack">
      <PageHeader
        description={
          props.embedded
            ? 'Live reachability over the same peer records managed on Peers & trust.'
            : undefined
        }
        actions={
          <button
            className="ghost-button"
            type="button"
            disabled={topologyQuery.isFetching}
            onClick={() => void topologyQuery.refetch()}
          >
            Refresh
          </button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>HQ instance</CardTitle>
          <CardDescription>
            {topology?.hq.instanceId || 'unavailable'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {topology ? (
            <div className="key-value-grid">
              <div>
                <span>Status</span>
                <strong>local</strong>
              </div>
              <div>
                <span>Version</span>
                <strong>{topology.hq.version}</strong>
              </div>
              <div>
                <span>Latency</span>
                <strong>{formatLatency(topology.hq.latencyMs)}</strong>
              </div>
              <div>
                <span>Public key</span>
                <strong>
                  {shortFingerprint(topology.hq.publicKeyFingerprint)}
                </strong>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              {topologyQuery.isLoading
                ? 'Loading fleet topology...'
                : 'Fleet topology unavailable.'}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Child instances</CardTitle>
          <CardDescription>
            {`${instances.length} instance${instances.length === 1 ? '' : 's'}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {topologyQuery.isLoading ? (
            <div className="empty-state">Loading instances...</div>
          ) : instances.length ? (
            <div className="list-stack">
              {instances.map((instance) => (
                <div className="list-row" key={instance.peerId}>
                  <div className="list-row-main">
                    <strong>{instance.peerId}</strong>
                    <small>
                      {instance.version || 'version unknown'} ·{' '}
                      {formatLatency(instance.latencyMs)} · last seen{' '}
                      {formatRelativeTime(instance.lastSeenAt)}
                    </small>
                    {instance.error ? (
                      <small className="row-status-note-danger">
                        {instance.error}
                      </small>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    {statusPill(instance.status)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No child instances configured.</div>
          )}
          {topologyQuery.error ? (
            <small className="row-status-note-danger">
              {topologyQuery.error instanceof Error
                ? topologyQuery.error.message
                : 'Fleet topology load failed.'}
            </small>
          ) : null}
        </CardContent>
      </Card>

      {instances.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Instance detail</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="list-stack">
              {instances.map((instance) => (
                <div className="key-value-grid" key={instance.peerId}>
                  <div>
                    <span>Instance</span>
                    <strong>{instance.peerId}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{instance.status}</strong>
                  </div>
                  <div>
                    <span>Agent Card</span>
                    <strong>{instance.agentCardUrl || 'not configured'}</strong>
                  </div>
                  <div>
                    <span>Delivery URL</span>
                    <strong>{instance.deliveryUrl || 'not configured'}</strong>
                  </div>
                  <div>
                    <span>Trusted</span>
                    <strong>{formatDateTime(instance.trustedAt)}</strong>
                  </div>
                  <div>
                    <span>Updated</span>
                    <strong>{formatDateTime(instance.updatedAt)}</strong>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
