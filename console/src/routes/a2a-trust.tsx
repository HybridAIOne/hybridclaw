import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  deleteA2ATrustPeer,
  fetchA2ATrust,
  revokeA2ATrustPeer,
  upsertA2ATrustPeer,
} from '../api/client';
import type { AdminA2ATrustPeer } from '../api/types';
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

function peerStatus(peer: AdminA2ATrustPeer) {
  if (peer.status === 'revoked') {
    return (
      <BooleanPill value={false} falseLabel="revoked" falseTone="danger" />
    );
  }
  return <BooleanPill value={true} trueLabel="trusted" />;
}

export function A2ATrustPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [pinPeerId, setPinPeerId] = useState('');
  const [pinAgentCardUrl, setPinAgentCardUrl] = useState('');
  const [pinDeliveryUrl, setPinDeliveryUrl] = useState('');
  const [pinFingerprint, setPinFingerprint] = useState('');
  const [pinPublicKeyJwk, setPinPublicKeyJwk] = useState('');
  const [pinReason, setPinReason] = useState('');

  const trustQuery = useQuery({
    queryKey: ['a2a-trust', auth.token],
    queryFn: () => fetchA2ATrust(auth.token),
  });

  const revokeMutation = useMutation({
    mutationFn: (peerId: string) =>
      revokeA2ATrustPeer(auth.token, {
        peerId,
        reason: revokeReason,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['a2a-trust', auth.token], data);
    },
  });

  const upsertMutation = useMutation({
    mutationFn: () => {
      const publicKeyJwk = pinPublicKeyJwk.trim()
        ? JSON.parse(pinPublicKeyJwk)
        : undefined;
      return upsertA2ATrustPeer(auth.token, {
        peerId: pinPeerId,
        agentCardUrl: pinAgentCardUrl || undefined,
        deliveryUrl: pinDeliveryUrl || undefined,
        publicKeyFingerprint: pinFingerprint || undefined,
        publicKeyJwk,
        reason: pinReason || undefined,
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['a2a-trust', auth.token], data);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (peerId: string) => deleteA2ATrustPeer(auth.token, peerId),
    onSuccess: (data) => {
      queryClient.setQueryData(['a2a-trust', auth.token], data);
      setSelectedPeerId(data.peers[0]?.peerId || null);
    },
  });

  const peers = trustQuery.data?.peers || [];
  const selectedPeer =
    peers.find((peer) => peer.peerId === selectedPeerId) || peers[0] || null;

  function fillSelectedPeer(peer: AdminA2ATrustPeer): void {
    setPinPeerId(peer.peerId);
    setPinAgentCardUrl(peer.agentCardUrl);
    setPinDeliveryUrl(peer.deliveryUrl);
    setPinFingerprint(peer.publicKeyFingerprint);
    setPinPublicKeyJwk(
      peer.publicKeyJwk ? JSON.stringify(peer.publicKeyJwk, null, 2) : '',
    );
    setPinReason('');
  }

  return (
    <div className="page-stack">
      <PageHeader title="A2A Trust" />

      <Card>
        <CardHeader>
          <CardTitle>Local identity</CardTitle>
        </CardHeader>
        <CardContent>
        {trustQuery.isLoading ? (
          <div className="empty-state">Loading identity...</div>
        ) : trustQuery.data ? (
          <div className="key-value-grid">
            <div>
              <span>Instance</span>
              <strong>{trustQuery.data.identity.instanceId}</strong>
            </div>
            <div>
              <span>Public key</span>
              <strong>
                {shortFingerprint(
                  trustQuery.data.identity.publicKeyFingerprint,
                )}
              </strong>
            </div>
          </div>
        ) : (
          <div className="empty-state">Identity unavailable.</div>
        )}
        </CardContent>
      </Card>

      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Trusted peers</CardTitle>
            <CardDescription>
              {`${peers.length} peer${peers.length === 1 ? '' : 's'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
          {trustQuery.isLoading ? (
            <div className="empty-state">Loading peers...</div>
          ) : peers.length ? (
            <div className="list-stack selectable-list">
              {peers.map((peer) => (
                <button
                  key={peer.peerId}
                  className={
                    peer.peerId === selectedPeer?.peerId
                      ? 'selectable-row active'
                      : 'selectable-row'
                  }
                  type="button"
                  onClick={() => setSelectedPeerId(peer.peerId)}
                >
                  <div>
                    <strong>{peer.peerId}</strong>
                    <small>{shortFingerprint(peer.publicKeyFingerprint)}</small>
                  </div>
                  {peerStatus(peer)}
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">No A2A peer keys cached.</div>
          )}
          </CardContent>
        </Card>

        <div className="sticky-detail">
          <Card variant="muted">
            <CardHeader>
              <CardTitle>Peer detail</CardTitle>
            </CardHeader>
            <CardContent>
            {!selectedPeer ? (
              <div className="empty-state">Select a peer.</div>
            ) : (
              <div className="detail-stack">
                <div className="key-value-grid">
                  <div>
                    <span>Peer</span>
                    <strong>{selectedPeer.peerId}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{selectedPeer.status}</strong>
                  </div>
                  <div>
                    <span>Trusted</span>
                    <strong>{formatDateTime(selectedPeer.trustedAt)}</strong>
                  </div>
                  <div>
                    <span>Last seen</span>
                    <strong>
                      {formatRelativeTime(selectedPeer.lastSeenAt)}
                    </strong>
                  </div>
                  <div>
                    <span>Agent Card</span>
                    <strong>{selectedPeer.agentCardUrl}</strong>
                  </div>
                  <div>
                    <span>Delivery URL</span>
                    <strong>{selectedPeer.deliveryUrl}</strong>
                  </div>
                  <div>
                    <span>Fingerprint</span>
                    <strong>{selectedPeer.publicKeyFingerprint}</strong>
                  </div>
                  <div>
                    <span>Mismatch</span>
                    <strong>{selectedPeer.lastMismatchAt || 'none'}</strong>
                  </div>
                </div>

                <label className="field">
                  <span>Revocation reason</span>
                  <input
                    value={revokeReason}
                    onChange={(event) => setRevokeReason(event.target.value)}
                  />
                </label>
                <button
                  className="danger-button"
                  type="button"
                  disabled={
                    selectedPeer.status === 'revoked' ||
                    revokeMutation.isPending
                  }
                  onClick={() => revokeMutation.mutate(selectedPeer.peerId)}
                >
                  Revoke
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(selectedPeer.peerId)}
                >
                  Delete
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => fillSelectedPeer(selectedPeer)}
                >
                  Use in override
                </button>
                {revokeMutation.error ? (
                  <small className="row-status-note-danger">
                    {revokeMutation.error instanceof Error
                      ? revokeMutation.error.message
                      : 'Revocation failed.'}
                  </small>
                ) : null}
                {deleteMutation.error ? (
                  <small className="row-status-note-danger">
                    {deleteMutation.error instanceof Error
                      ? deleteMutation.error.message
                      : 'Delete failed.'}
                  </small>
                ) : null}
              </div>
            )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Operator override</CardTitle>
            </CardHeader>
            <CardContent>
            <div className="detail-stack">
              <label className="field">
                <span>Peer</span>
                <input
                  value={pinPeerId}
                  onChange={(event) => setPinPeerId(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Agent Card</span>
                <input
                  value={pinAgentCardUrl}
                  onChange={(event) => setPinAgentCardUrl(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Delivery URL</span>
                <input
                  value={pinDeliveryUrl}
                  onChange={(event) => setPinDeliveryUrl(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Fingerprint</span>
                <input
                  value={pinFingerprint}
                  onChange={(event) => setPinFingerprint(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Public JWK</span>
                <textarea
                  rows={5}
                  value={pinPublicKeyJwk}
                  onChange={(event) => setPinPublicKeyJwk(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Reason</span>
                <input
                  value={pinReason}
                  onChange={(event) => setPinReason(event.target.value)}
                />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={!pinPeerId.trim() || upsertMutation.isPending}
                onClick={() => upsertMutation.mutate()}
              >
                Trust
              </button>
              {upsertMutation.error ? (
                <small className="row-status-note-danger">
                  {upsertMutation.error instanceof Error
                    ? upsertMutation.error.message
                    : 'Trust update failed.'}
                </small>
              ) : null}
            </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
