export type SignalPairingStatus =
  | 'idle'
  | 'starting'
  | 'qr'
  | 'complete'
  | 'error';

export interface SignalPairingState {
  status: SignalPairingStatus;
  pairingQrText: string | null;
  pairingUri: string | null;
  updatedAt: string | null;
  error: string | null;
}

let currentPairingState: SignalPairingState = {
  status: 'idle',
  pairingQrText: null,
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
    pairingUri: null,
    updatedAt: now(),
    error: null,
  };
}

export function setSignalPairingQr(params: {
  pairingQrText: string;
  pairingUri: string;
}): void {
  currentPairingState = {
    status: 'qr',
    pairingQrText: params.pairingQrText,
    pairingUri: params.pairingUri,
    updatedAt: now(),
    error: null,
  };
}

export function setSignalPairingComplete(): void {
  currentPairingState = {
    ...currentPairingState,
    status: 'complete',
    updatedAt: now(),
    error: null,
  };
}

export function setSignalPairingError(error: string): void {
  currentPairingState = {
    ...currentPairingState,
    status: 'error',
    updatedAt: now(),
    error,
  };
}

export function clearSignalPairingState(): void {
  currentPairingState = {
    status: 'idle',
    pairingQrText: null,
    pairingUri: null,
    updatedAt: null,
    error: null,
  };
}

export function getSignalPairingState(): SignalPairingState {
  return { ...currentPairingState };
}
