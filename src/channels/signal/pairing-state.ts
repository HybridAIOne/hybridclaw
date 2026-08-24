/**
 * Signal pairing state shared by the gateway API and admin console.
 *
 * Terminal states discard provisioning URIs and rendered QR material so an
 * expired link token cannot remain actionable. Process lifecycle lives elsewhere.
 */
export type SignalPairingStatus =
  | 'idle'
  | 'starting'
  | 'qr'
  | 'complete'
  | 'error';

export interface SignalPairingState {
  status: SignalPairingStatus;
  pairingQrText: string | null;
  pairingQrSvg: string | null;
  pairingUri: string | null;
  updatedAt: string | null;
  error: string | null;
}

let currentPairingState: SignalPairingState = {
  status: 'idle',
  pairingQrText: null,
  pairingQrSvg: null,
  pairingUri: null,
  updatedAt: null,
  error: null,
};

function now(): string {
  return new Date().toISOString();
}

export function setSignalPairingStarting(): void {
  currentPairingState = {
    status: 'starting',
    pairingQrText: null,
    pairingQrSvg: null,
    pairingUri: null,
    updatedAt: now(),
    error: null,
  };
}

export function setSignalPairingQr(params: {
  pairingQrText: string;
  pairingQrSvg: string;
  pairingUri: string;
}): void {
  currentPairingState = {
    status: 'qr',
    pairingQrText: params.pairingQrText,
    pairingQrSvg: params.pairingQrSvg,
    pairingUri: params.pairingUri,
    updatedAt: now(),
    error: null,
  };
}

export function setSignalPairingComplete(): void {
  currentPairingState = {
    status: 'complete',
    pairingQrText: null,
    pairingQrSvg: null,
    pairingUri: null,
    updatedAt: now(),
    error: null,
  };
}

export function setSignalPairingError(error: string): void {
  currentPairingState = {
    status: 'error',
    pairingQrText: null,
    pairingQrSvg: null,
    pairingUri: null,
    updatedAt: now(),
    error,
  };
}

export function clearSignalPairingState(): void {
  currentPairingState = {
    status: 'idle',
    pairingQrText: null,
    pairingQrSvg: null,
    pairingUri: null,
    updatedAt: null,
    error: null,
  };
}

export function getSignalPairingState(): SignalPairingState {
  return { ...currentPairingState };
}
