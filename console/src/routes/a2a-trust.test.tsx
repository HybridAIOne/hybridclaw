import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminA2ATrustResponse } from '../api/types';
import { renderWithProviders } from '../test-utils';
import { A2ATrustPage } from './a2a-trust';

const fetchA2ATrustMock = vi.fn<() => Promise<AdminA2ATrustResponse>>();
const saveA2ALocalModeMock =
  vi.fn<(token: string, enabled: boolean) => Promise<AdminA2ATrustResponse>>();
const saveA2AE2EERequiredMock =
  vi.fn<(token: string, required: boolean) => Promise<AdminA2ATrustResponse>>();

vi.mock('../api/client', () => ({
  approveA2APairingRequest: vi.fn(),
  declineA2APairingRequest: vi.fn(),
  deleteA2ATrustPeer: vi.fn(),
  fetchA2ATrust: () => fetchA2ATrustMock(),
  previewA2APairing: vi.fn(),
  revokeA2ATrustPeer: vi.fn(),
  saveA2AE2EERequired: (token: string, required: boolean) =>
    saveA2AE2EERequiredMock(token, required),
  saveA2ALocalMode: (token: string, enabled: boolean) =>
    saveA2ALocalModeMock(token, enabled),
  startA2APairing: vi.fn(),
  upsertA2ATrustPeer: vi.fn(),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

function makeTrustResponse(enabled: boolean): AdminA2ATrustResponse {
  return {
    identity: {
      instanceId: 'instance-test',
      publicKeyFingerprint: 'fingerprint-test',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'test-key' },
      e2eePublicKeyFingerprint: 'e2ee-fingerprint-test',
      e2eePublicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'test-key' },
    },
    localMode: { enabled },
    e2ee: { required: enabled },
    peers: [],
    pairingRequests: [],
  };
}

describe('A2ATrustPage', () => {
  beforeEach(() => {
    fetchA2ATrustMock.mockReset();
    saveA2ALocalModeMock.mockReset();
    saveA2AE2EERequiredMock.mockReset();
    fetchA2ATrustMock.mockResolvedValue(makeTrustResponse(false));
    saveA2ALocalModeMock.mockResolvedValue(makeTrustResponse(true));
    saveA2AE2EERequiredMock.mockResolvedValue(makeTrustResponse(true));
  });

  it('toggles A2A local mode from the A2A admin page', async () => {
    renderWithProviders(<A2ATrustPage />);

    const toggle = await screen.findByRole('switch', {
      name: 'A2A local mode',
    });
    await waitFor(() => {
      expect(toggle.hasAttribute('disabled')).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(saveA2ALocalModeMock).toHaveBeenCalledWith('test-token', true);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('requires E2EE from the A2A admin page', async () => {
    renderWithProviders(<A2ATrustPage />);

    const toggle = await screen.findByRole('switch', {
      name: 'Require A2A E2EE',
    });
    await waitFor(() => {
      expect(toggle.hasAttribute('disabled')).toBe(false);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(saveA2AE2EERequiredMock).toHaveBeenCalledWith('test-token', true);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });
});
