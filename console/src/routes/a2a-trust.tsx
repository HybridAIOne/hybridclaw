import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  approveA2APairingRequest,
  declineA2APairingRequest,
  deleteA2ATrustPeer,
  fetchA2ATrust,
  previewA2APairing,
  revokeA2ATrustPeer,
  startA2APairing,
  upsertA2ATrustPeer,
} from '../api/client';
import type {
  AdminA2APairingPreviewResponse,
  AdminA2APairingStartResponse,
  AdminA2ATrustPeer,
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
  const [pairPeerUrl, setPairPeerUrl] = useState('');
  const [pairCanonicalId, setPairCanonicalId] = useState('');
  const [pairCanonicalInstanceId, setPairCanonicalInstanceId] = useState('');
  const [pairReason, setPairReason] = useState('');
  const [pairNotifyPeer, setPairNotifyPeer] = useState(true);
  const [pairPreview, setPairPreview] =
    useState<AdminA2APairingPreviewResponse | null>(null);
  const [pairResult, setPairResult] =
    useState<AdminA2APairingStartResponse | null>(null);
  const [pairingDecisionReason, setPairingDecisionReason] = useState('');

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

  const startPairingMutation = useMutation({
    mutationFn: () =>
      startA2APairing(auth.token, {
        peerUrl: pairPeerUrl || undefined,
        canonicalId: pairCanonicalId || undefined,
        canonicalInstanceId: pairCanonicalInstanceId || undefined,
        reason: pairReason || undefined,
        notifyPeer: pairNotifyPeer,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['a2a-trust', auth.token], data);
      setPairResult(data);
      setSelectedPeerId(data.proposal.peerId);
    },
  });

  const previewPairingMutation = useMutation({
    mutationFn: () =>
      previewA2APairing(auth.token, {
        peerUrl: pairPeerUrl || undefined,
        canonicalId: pairCanonicalId || undefined,
        canonicalInstanceId: pairCanonicalInstanceId || undefined,
      }),
    onSuccess: (data) => {
      setPairPreview(data);
      setPairResult(null);
    },
  });

  const approvePairingMutation = useMutation({
    mutationFn: (requestId: string) =>
      approveA2APairingRequest(auth.token, requestId, pairingDecisionReason),
    onSuccess: (data) => {
      queryClient.setQueryData(['a2a-trust', auth.token], data);
    },
  });

  const declinePairingMutation = useMutation({
    mutationFn: (requestId: string) =>
      declineA2APairingRequest(auth.token, requestId, pairingDecisionReason),
    onSuccess: (data) => {
      queryClient.setQueryData(['a2a-trust', auth.token], data);
    },
  });

  const peers = trustQuery.data?.peers || [];
  const pairingRequests = trustQuery.data?.pairingRequests || [];
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

  function clearPairPreview(): void {
    setPairPreview(null);
    setPairResult(null);
  }

  return (
    <div className="page-stack">
      <PageHeader />

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

      <Card>
        <CardHeader>
          <CardTitle>Add peer instance</CardTitle>
          <CardDescription>
            Fetch a peer Agent Card, pin its public key, and notify the remote
            operator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="detail-stack">
            <div className="two-column-grid">
              <Field>
                <FieldLabel>Peer URL</FieldLabel>
                <Input
                  placeholder="https://peer.example.com"
                  value={pairPeerUrl}
                  onChange={(event) => {
                    setPairPeerUrl(event.target.value);
                    clearPairPreview();
                  }}
                />
              </Field>
              <Field>
                <FieldLabel>Canonical agent id</FieldLabel>
                <Input
                  placeholder="agent@user@instance"
                  value={pairCanonicalId}
                  onChange={(event) => {
                    setPairCanonicalId(event.target.value);
                    clearPairPreview();
                  }}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Canonical instance id</FieldLabel>
              <Input
                placeholder="instance-prod"
                value={pairCanonicalInstanceId}
                onChange={(event) => {
                  setPairCanonicalInstanceId(event.target.value);
                  clearPairPreview();
                }}
              />
            </Field>
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Input
                value={pairReason}
                onChange={(event) => setPairReason(event.target.value)}
              />
            </Field>
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={pairNotifyPeer}
                onChange={(event) => setPairNotifyPeer(event.target.checked)}
              />
              <span>Send peer-side approval prompt</span>
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={
                (!pairPeerUrl.trim() &&
                  !pairCanonicalId.trim() &&
                  !pairCanonicalInstanceId.trim()) ||
                previewPairingMutation.isPending
              }
              onClick={() => previewPairingMutation.mutate()}
            >
              Fetch peer
            </button>
            {pairPreview ? (
              <div className="info-row">
                <div>
                  <strong>{pairPreview.proposal.peerId}</strong>
                  <small>{pairPreview.proposal.agentCardUrl}</small>
                  <small>{pairPreview.proposal.deliveryUrl}</small>
                  <small>{pairPreview.proposal.publicKeyFingerprint}</small>
                </div>
              </div>
            ) : null}
            <button
              className="primary-button"
              type="button"
              disabled={
                !pairPreview ||
                startPairingMutation.isPending ||
                previewPairingMutation.isPending
              }
              onClick={() => startPairingMutation.mutate()}
            >
              Trust peer
            </button>
            {pairResult ? (
              <small className="row-status-note">
                {`Trusted ${pairResult.proposal.peerId} (${shortFingerprint(
                  pairResult.proposal.publicKeyFingerprint,
                )}); peer prompt ${pairResult.remoteNotification.status}.`}
              </small>
            ) : null}
            {startPairingMutation.error ? (
              <small className="row-status-note-danger">
                {startPairingMutation.error instanceof Error
                  ? startPairingMutation.error.message
                  : 'Pairing failed.'}
              </small>
            ) : null}
            {previewPairingMutation.error ? (
              <small className="row-status-note-danger">
                {previewPairingMutation.error instanceof Error
                  ? previewPairingMutation.error.message
                  : 'Pairing preview failed.'}
              </small>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Incoming pairing requests</CardTitle>
          <CardDescription>
            {`${pairingRequests.length} request${
              pairingRequests.length === 1 ? '' : 's'
            }`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pairingRequests.length ? (
            <div className="detail-stack">
              <Field>
                <FieldLabel>Decision reason</FieldLabel>
                <Input
                  value={pairingDecisionReason}
                  onChange={(event) =>
                    setPairingDecisionReason(event.target.value)
                  }
                />
              </Field>
              <div className="list-stack">
                {pairingRequests.map((request) => (
                  <div className="info-row" key={request.requestId}>
                    <div>
                      <strong>{request.peerId}</strong>
                      <small>
                        {`${request.status} - ${shortFingerprint(
                          request.publicKeyFingerprint,
                        )}`}
                      </small>
                      {request.pairingId ? (
                        <small>{`Pairing ${request.pairingId}`}</small>
                      ) : null}
                    </div>
                    <div className="row-actions">
                      <button
                        className="primary-button"
                        type="button"
                        disabled={
                          request.status !== 'pending' ||
                          approvePairingMutation.isPending
                        }
                        onClick={() =>
                          approvePairingMutation.mutate(request.requestId)
                        }
                      >
                        Approve
                      </button>
                      <button
                        className="danger-button"
                        type="button"
                        disabled={
                          request.status !== 'pending' ||
                          declinePairingMutation.isPending
                        }
                        onClick={() =>
                          declinePairingMutation.mutate(request.requestId)
                        }
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {approvePairingMutation.error || declinePairingMutation.error ? (
                <small className="row-status-note-danger">
                  {(approvePairingMutation.error ||
                    declinePairingMutation.error) instanceof Error
                    ? (
                        approvePairingMutation.error ||
                        declinePairingMutation.error
                      )?.message
                    : 'Pairing decision failed.'}
                </small>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">No incoming pairing requests.</div>
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
                      <small>
                        {shortFingerprint(peer.publicKeyFingerprint)}
                      </small>
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

                  <Field>
                    <FieldLabel>Revocation reason</FieldLabel>
                    <Input
                      value={revokeReason}
                      onChange={(event) => setRevokeReason(event.target.value)}
                    />
                  </Field>
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
                <Field>
                  <FieldLabel>Peer</FieldLabel>
                  <Input
                    value={pinPeerId}
                    onChange={(event) => setPinPeerId(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Agent Card</FieldLabel>
                  <Input
                    value={pinAgentCardUrl}
                    onChange={(event) => setPinAgentCardUrl(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Delivery URL</FieldLabel>
                  <Input
                    value={pinDeliveryUrl}
                    onChange={(event) => setPinDeliveryUrl(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Fingerprint</FieldLabel>
                  <Input
                    value={pinFingerprint}
                    onChange={(event) => setPinFingerprint(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Public JWK</FieldLabel>
                  <Textarea
                    rows={5}
                    value={pinPublicKeyJwk}
                    onChange={(event) => setPinPublicKeyJwk(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Reason</FieldLabel>
                  <Input
                    value={pinReason}
                    onChange={(event) => setPinReason(event.target.value)}
                  />
                </Field>
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
