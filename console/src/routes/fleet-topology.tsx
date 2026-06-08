import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  deleteFleetTopologyInstance,
  fetchFleetTopology,
  upsertFleetTopologyInstance,
} from '../api/client';
import type {
  AdminFleetTopologyInstance,
  AdminFleetTopologyInstanceStatus,
} from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { Textarea } from '../components/textarea';
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

export function FleetTopologyPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [peerId, setPeerId] = useState('');
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [deliveryUrl, setDeliveryUrl] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [publicKeyJwk, setPublicKeyJwk] = useState('');
  const [reason, setReason] = useState('');

  const topologyQuery = useQuery({
    queryKey: ['fleet-topology', auth.token],
    queryFn: () => fetchFleetTopology(auth.token),
  });

  const upsertMutation = useMutation({
    mutationFn: () => {
      const parsedPublicKeyJwk = publicKeyJwk.trim()
        ? JSON.parse(publicKeyJwk)
        : undefined;
      return upsertFleetTopologyInstance(auth.token, {
        peerId,
        agentCardUrl: agentCardUrl || undefined,
        deliveryUrl: deliveryUrl || undefined,
        publicKeyFingerprint: fingerprint || undefined,
        publicKeyJwk: parsedPublicKeyJwk,
        reason: reason || undefined,
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['fleet-topology', auth.token], data);
      setPeerId('');
      setAgentCardUrl('');
      setDeliveryUrl('');
      setFingerprint('');
      setPublicKeyJwk('');
      setReason('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (instance: AdminFleetTopologyInstance) =>
      deleteFleetTopologyInstance(auth.token, instance.peerId),
    onSuccess: (data) => {
      queryClient.setQueryData(['fleet-topology', auth.token], data);
    },
  });

  const topology = topologyQuery.data;
  const instances = topology?.instances || [];
  const canSubmit =
    peerId.trim() && (fingerprint.trim() || publicKeyJwk.trim());

  function fillInstance(instance: AdminFleetTopologyInstance): void {
    setPeerId(instance.peerId);
    setAgentCardUrl(instance.agentCardUrl);
    setDeliveryUrl(instance.deliveryUrl);
    setFingerprint(instance.publicKeyFingerprint);
    setPublicKeyJwk('');
    setReason('');
  }

  return (
    <div className="page-stack">
      <PageHeader
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

      <div className="two-column-grid">
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
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => fillInstance(instance)}
                      >
                        Edit
                      </button>
                      <button
                        className="danger-button"
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(instance)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No child instances configured.</div>
            )}
            {deleteMutation.error ? (
              <small className="row-status-note-danger">
                {deleteMutation.error instanceof Error
                  ? deleteMutation.error.message
                  : 'Remove failed.'}
              </small>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add instance</CardTitle>
            <CardDescription>A2A trust ledger</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="detail-stack">
              <Field>
                <FieldLabel>Instance</FieldLabel>
                <Input
                  value={peerId}
                  onChange={(event) => setPeerId(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Agent Card</FieldLabel>
                <Input
                  value={agentCardUrl}
                  onChange={(event) => setAgentCardUrl(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Delivery URL</FieldLabel>
                <Input
                  value={deliveryUrl}
                  onChange={(event) => setDeliveryUrl(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Fingerprint</FieldLabel>
                <Input
                  value={fingerprint}
                  onChange={(event) => setFingerprint(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Public JWK</FieldLabel>
                <Textarea
                  rows={5}
                  value={publicKeyJwk}
                  onChange={(event) => setPublicKeyJwk(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Reason</FieldLabel>
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <button
                className="primary-button"
                type="button"
                disabled={!canSubmit || upsertMutation.isPending}
                onClick={() => upsertMutation.mutate()}
              >
                Trust instance
              </button>
              {upsertMutation.error ? (
                <small className="row-status-note-danger">
                  {upsertMutation.error instanceof Error
                    ? upsertMutation.error.message
                    : 'Trust update failed.'}
                </small>
              ) : null}
              {topologyQuery.error ? (
                <small className="row-status-note-danger">
                  {topologyQuery.error instanceof Error
                    ? topologyQuery.error.message
                    : 'Fleet topology load failed.'}
                </small>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

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
