import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminFleetTopologyResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { FleetTopologyPage } from './fleet-topology';

const fetchFleetTopologyMock =
  vi.fn<() => Promise<AdminFleetTopologyResponse>>();
const useAuthMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('../api/client', () => ({
  fetchFleetTopology: () => fetchFleetTopologyMock(),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

describe('FleetTopologyPage', () => {
  beforeEach(() => {
    fetchFleetTopologyMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchFleetTopologyMock.mockResolvedValue({
      hq: {
        instanceId: 'hq-1',
        publicKeyFingerprint: 'hq-fingerprint',
        version: '0.12.6',
        status: 'local',
        latencyMs: 0,
        lastSeenAt: '2026-07-18T10:00:00.000Z',
      },
      instances: [
        {
          peerId: 'peer-1',
          agentCardUrl: 'https://peer.example/.well-known/agent-card.json',
          deliveryUrl: 'https://peer.example/a2a',
          publicKeyFingerprint: 'peer-fingerprint',
          trustStatus: 'trusted',
          status: 'online',
          version: '0.12.6',
          latencyMs: 18,
          error: null,
          trustedAt: '2026-07-17T10:00:00.000Z',
          createdAt: '2026-07-17T10:00:00.000Z',
          updatedAt: '2026-07-18T10:00:00.000Z',
          lastSeenAt: '2026-07-18T10:00:00.000Z',
          revokedAt: null,
          revokedReason: null,
        },
      ],
    });
  });

  it('keeps topology read-only without duplicating peer management', async () => {
    renderWithProviders(<FleetTopologyPage />);

    expect(await screen.findAllByText('peer-1')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trust instance' })).toBeNull();
    expect(screen.queryByText('Peer trust')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
